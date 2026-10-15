// Lambda behind a Function URL: GitHub webhook intake. Trust is decided here,
// on the signed payload; only then does a Step Functions execution start.
// PR events only feed the decision timeline with what the human did.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ExecutionAlreadyExists, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { eventLog, type GitHubAuth, githubAuthFromEnv, loadSecrets, logged } from "@mork/sources";
import { type Outcome, prTask, recordOutcome, type TimelineStore } from "@mork/timeline";
import { DynamoStore } from "@mork/timeline/dynamo";
import { fixTrigger } from "./fix.ts";
import { GitHub } from "./github.ts";
import { LABELS } from "./origin.ts";

type UrlEvent = {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
  requestContext?: { http?: { method?: string; path?: string } };
};
type UrlResult = { statusCode: number; body?: string };

const sfn = new SFNClient({});
const TRUSTED_ROLES = new Set(["admin", "maintain", "write", "triage"]);
/** Asking Mork to change code on a PR needs write access, like pushing to it would. */
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

export function signatureValid(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret.trim() || secret.trim().toLowerCase() === "unset") return false;
  const presented = Buffer.from(header ?? "");
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const events = eventLog(process.env, "intake");
const log = (kind: string, detail: Record<string, unknown>) => events.log(kind, { detail });

type PrPayload = {
  action?: string;
  pull_request?: { number: number; merged?: boolean };
  review?: { state?: string };
  sender?: { login?: string };
};

/** The human's verdict carried by a PR webhook, if any. */
export function prOutcome(event: string | undefined, payload: PrPayload): Outcome | undefined {
  if (event === "pull_request" && payload.action === "closed") return payload.pull_request?.merged ? "merged" : "closed";
  if (event === "pull_request_review" && payload.action === "submitted") {
    const state = payload.review?.state?.toLowerCase();
    if (state === "approved") return "approved";
    if (state === "changes_requested") return "changes_requested";
  }
  return undefined;
}

let timeline: TimelineStore | undefined;
let githubAuth: GitHubAuth | undefined;

export const handler = (event: UrlEvent): Promise<UrlResult> => logged(events, () => handle(event));

async function handle(event: UrlEvent): Promise<UrlResult> {
  if (event.requestContext?.http?.path === "/health") return { statusCode: 200, body: "ok" };
  if (event.requestContext?.http?.method !== "POST") return { statusCode: 404 };
  await loadSecrets(process.env, ["WEBHOOK_SECRET"]);
  const body = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  // An empty secret would accept any signature computed with an empty key.
  const secret = process.env.WEBHOOK_SECRET ?? "";
  if (!secret || !signatureValid(secret, body, headers["x-hub-signature-256"])) return { statusCode: 401 };

  const payload = JSON.parse(body.toString("utf8"));
  const repo: string | undefined = payload.repository?.full_name;
  const allowlist = (process.env.REPO_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const githubEvent = headers["x-github-event"];
  const outcome = prOutcome(githubEvent, payload);
  if (outcome && repo && allowlist.includes(repo) && payload.pull_request) {
    timeline ??= DynamoStore.fromEnv(process.env);
    const known = await recordOutcome(timeline, {
      repo,
      pr: payload.pull_request.number,
      delivery: headers["x-github-delivery"] ?? `${githubEvent}-${Date.now()}`,
      outcome,
      by: payload.sender?.login,
    });
    log(known ? "outcome.recorded" : "outcome.ignored", { repo, pr: payload.pull_request.number, outcome });
  }
  const fix = fixTrigger(githubEvent, payload);
  if (fix) {
    if (repo && allowlist.includes(repo)) await startFix(repo, fix);
    return { statusCode: 202 };
  }
  if (outcome) return { statusCode: 202 };
  if (headers["x-github-event"] !== "issues" || payload.action !== "labeled" || payload.label?.name !== LABELS.trigger.name)
    return { statusCode: 202 };
  if (!repo || !allowlist.includes(repo) || payload.issue?.pull_request || payload.sender?.type === "Bot") {
    log("intake.ignored", { repo, sender: payload.sender?.login });
    return { statusCode: 202 };
  }
  // Labels attached when an issue is created also fire `labeled`; check who labeled it.
  githubAuth ??= await githubAuthFromEnv(process.env);
  const github = new GitHub(githubAuth.token);
  const role = await github.permission(repo, payload.sender.login);
  if (!role || !TRUSTED_ROLES.has(role)) {
    log("intake.rejected", { repo, issue: payload.issue.number, sender: payload.sender.login, role });
    return { statusCode: 202 };
  }
  // Named after the delivery: GitHub redelivering the same event starts nothing new.
  const delivery = (headers["x-github-delivery"] ?? `${Date.now()}`).replace(/[^A-Za-z0-9-]/g, "");
  const name = `${repo.replace(/[^A-Za-z0-9-]/g, "-")}-${payload.issue.number}-${delivery}`.slice(-80);
  try {
    const started = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: process.env.STATE_MACHINE_ARN,
        name,
        input: JSON.stringify({ repo, issue: payload.issue.number, requested_by: payload.sender.login }),
      }),
    );
    log("intake.started", { repo, issue: payload.issue.number, execution: started.executionArn });
  } catch (error) {
    if (!(error instanceof ExecutionAlreadyExists)) throw error;
    log("intake.duplicate", { repo, issue: payload.issue.number, name });
  }
  return { statusCode: 202 };
}

/** Starts a fix run for a Mork PR; the trigger key makes a redelivered webhook start nothing new. */
async function startFix(repo: string, fix: NonNullable<ReturnType<typeof fixTrigger>>): Promise<void> {
  timeline ??= DynamoStore.fromEnv(process.env);
  if (!(await prTask(timeline, repo, fix.pr))) {
    log("fix.ignored", { repo, pr: fix.pr, reason: "not a Mork PR" });
    return;
  }
  if (fix.sender) {
    githubAuth ??= await githubAuthFromEnv(process.env);
    const role = await new GitHub(githubAuth.token).permission(repo, fix.sender);
    if (!role || !WRITE_ROLES.has(role)) {
      log("fix.rejected", { repo, pr: fix.pr, sender: fix.sender, role });
      return;
    }
  }
  const name = `fix-${repo.replace(/[^A-Za-z0-9-]/g, "-")}-${fix.pr}-${fix.key}`.slice(-80);
  try {
    const started = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: process.env.STATE_MACHINE_ARN,
        name,
        input: JSON.stringify({ fix: { repo, pr: fix.pr, trigger: fix.trigger }, requested_by: fix.sender }),
      }),
    );
    log("fix.started", { repo, pr: fix.pr, trigger: fix.trigger.kind, execution: started.executionArn });
  } catch (error) {
    if (!(error instanceof ExecutionAlreadyExists)) throw error;
    log("fix.duplicate", { repo, pr: fix.pr, name });
  }
}
