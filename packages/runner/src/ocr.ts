// OCR is the only defect finder. It runs without platform credentials and with
// trusted configuration in a private home, on the exact commit the gate tested.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FINDING_CATEGORIES, type Review } from "@mork/contracts";
import { z } from "zod";
import { killUser, readAgentFile } from "./agentfs.ts";
import { execAsync, mustExec } from "./git.ts";
import { caBundle, egressEnv, type RunnerEnv } from "./llm.ts";
import type { ChangedFile } from "./review.ts";

const item = z.object({ path: z.string(), item_id: z.string() });
export const OcrResult = z.object({
  status: z.enum(["complete", "partial", "failed", "blocked"]),
  message: z.string().optional(),
  comments: z
    .array(
      z.object({
        path: z.string().min(1),
        start_line: z.number().int().positive(),
        content: z.string().min(1),
        existing_code: z.string().default(""),
        category: z.string().default("other"),
        severity: z.enum(["critical", "high", "medium", "low"]).default("medium"),
      }),
    )
    .nullable()
    .transform((comments) => comments ?? []),
  summary: z.object({ total_tokens: z.number().int().nonnegative() }),
  tool_calls: z.object({ total: z.number().int().nonnegative() }),
  manifest: z.object({
    input: z.object({ resolved_base: z.string(), resolved_head: z.string() }),
    coverage: z.object({ completed: z.array(item).nullable(), reused: z.array(item).nullable(), failed: z.array(item).nullable() }),
  }),
});
export type OcrResult = z.infer<typeof OcrResult>;

/** Both fresh and resumed results must identify the exact gate-tested range. */
export function parseOcrResult(value: unknown, base: string, head: string): OcrResult {
  const result = OcrResult.parse(value);
  if (result.manifest.input.resolved_base !== base || result.manifest.input.resolved_head !== head)
    throw new Error("OCR reviewed different commits from the gate");
  return result;
}

export function ocrReview(result: OcrResult, files: ChangedFile[]): Review {
  const reviewed = [...new Set([...(result.manifest.coverage.completed ?? []), ...(result.manifest.coverage.reused ?? [])].map((f) => f.path))];
  const findings: Review["findings"] = result.comments.map((c) => ({
    severity: { critical: "P0" as const, high: "P1" as const, medium: "P1" as const, low: "P2" as const }[c.severity],
    category: FINDING_CATEGORIES.find((value) => value === c.category) ?? "maintainability",
    where: `${c.path}:${c.start_line}`,
    quote: c.existing_code || "(no quotation supplied by OCR)",
    what: c.content,
    located: null,
    verification: { status: "unknown", reason: "Awaiting repository verification" },
  }));
  return {
    summary: `Open Code Review: ${result.status}, ${findings.length} findings`,
    files_reviewed: reviewed,
    criteria: [],
    findings,
    read_first: findings.slice(0, 3).map((f) => f.where),
    unreviewed_files: files.map((f) => f.path).filter((path) => !reviewed.includes(path)),
    incomplete:
      result.status === "complete" && !result.manifest.coverage.failed?.length
        ? []
        : [result.message ?? `OCR coverage incomplete (${result.status})`],
  };
}

export async function runOcr(env: RunnerEnv, repoDir: string, base: string, head: string, model: string): Promise<OcrResult> {
  const home = join(env.agentHome, "ocr");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const output = join(home, "review.json");
  const rule = join(home, "rule.json");
  // The CLI override prevents an untrusted repository rule from suppressing files.
  writeFileSync(
    rule,
    JSON.stringify({
      rules: [
        {
          path: "**/*",
          merge_system_rule: true,
          rule: "Find concrete defects in changed behaviour. Do not report style, formatting, naming, missing tests or refactoring opinions. Report each root cause once.",
        },
      ],
    }),
  );
  if (env.agentUid !== undefined) mustExec("chown", ["-R", `${env.agentUid}:${env.agentGid}`, home, repoDir]);
  const run = await execAsync(
    "ocr",
    ["review", "--from", base, "--to", head, "--effort", "medium", "--format", "json", "--audience", "agent", "--rule", rule, "--output", output],
    {
      cwd: repoDir,
      uid: env.agentUid,
      gid: env.agentGid,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "false",
        OCR_LLM_URL: env.llmBaseUrl,
        OCR_LLM_PROTOCOL: "openai",
        OCR_LLM_MODEL: model,
        OCR_LLM_TOKEN: env.trustedLocal?.apiKey ?? "added-by-egress",
        OCR_ENABLE_TELEMETRY: "0",
        ...(env.egress ? egressEnv(env.egress.proxy, caBundle(env)) : {}),
      },
    },
  );
  killUser(env.agentUid);
  const json = readAgentFile(output);
  if (!json) throw new Error(`OCR did not produce a review (exit ${run.code}): ${run.output.slice(-1000)}`);
  const result = parseOcrResult(JSON.parse(json), base, head);
  if (run.code !== 0 && result.status === "complete") throw new Error(`OCR failed with exit ${run.code}`);
  return result;
}
