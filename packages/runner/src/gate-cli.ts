// Local verification on the same gate path as Plan and Check, without AWS.
// Commands run as the current user; this is for repositories you trust.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HiddenTest, parseRepoConfig } from "@mork/contracts";
import { z } from "zod";
import { runGate } from "./gate.ts";
import { mustExec, SAFE_GIT } from "./git.ts";
import { gatePassed } from "./rules.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    repo: { type: "string" },
    base: { type: "string" },
    branch: { type: "string" },
    hidden: { type: "string" },
    mode: { type: "string", default: "after" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log("Usage: mise run gate:local -- --repo PATH --base COMMIT --hidden tests.json [--branch BRANCH] [--mode before|after]");
  console.log("Reads .mork/config.toml from the base commit. Hidden tests use the stored HiddenTest JSON array format.");
  console.log("Runs setup, repository checks and hidden tests in a disposable checkout as your current user. Use only trusted repositories.");
  process.exit(0);
}
if (!values.repo || !values.base || !values.hidden) throw new Error("--repo, --base and --hidden are required; use --help for usage");
if (values.mode !== "before" && values.mode !== "after") throw new Error("--mode must be before or after");
if (process.platform !== "linux")
  throw new Error("The local gate uses Linux descriptor-relative file access; use the runner container on other systems");
if (process.getuid?.() === 0) throw new Error("Run the local gate as a non-root user");
const source = resolve(values.repo);
const git = (...args: string[]) => mustExec("git", [...SAFE_GIT, "-C", source, ...args]).trim();
const base = git("rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`);
const branch = values.mode === "after" ? (values.branch ?? git("symbolic-ref", "--short", "HEAD")) : undefined;
const config = parseRepoConfig(mustExec("git", [...SAFE_GIT, "-C", source, "show", `${base}:.mork/config.toml`]));
const hidden = z
  .array(HiddenTest)
  .min(1)
  .parse(JSON.parse(readFileSync(values.hidden, "utf8")));
const work = mkdtempSync(join(tmpdir(), "mork-local-gate-"));
try {
  const report = await runGate(
    {
      mode: values.mode,
      repo: { full_name: "local/repository", default_branch: "main", base_sha: base },
      branch,
      localRepo: source,
      config,
      hidden_tests: hidden,
      allow_test_change: false,
    },
    "",
    work,
    { env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: work, CI: "1" } },
  );
  const passed =
    values.mode === "after"
      ? gatePassed(report)
      : (report.setup?.exit_code ?? 0) === 0 && report.hidden.length > 0 && report.hidden.every((test) => !test.passed);
  console.log(JSON.stringify({ passed, gate: report }, null, 2));
  process.exitCode = passed ? 0 : 1;
} finally {
  // Hidden test directories are read-only during verification.
  mustExec("chmod", ["-R", "u+rwX", work]);
  rmSync(work, { recursive: true, force: true });
}
