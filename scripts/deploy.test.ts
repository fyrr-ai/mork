import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deploy(args: string[], failFunction = "") {
  const root = mkdtempSync(join(tmpdir(), "mork-deploy-"));
  roots.push(root);
  const log = join(root, "calls");
  writeFileSync(log, "");
  writeFileSync(
    join(root, "aws"),
    `#!/usr/bin/env bash
printf 'aws %s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'sts get-caller-identity') echo 123456789012 ;;
  'lambda get-function') [[ "$*" != *"$FAIL_FUNCTION"* || -z "$FAIL_FUNCTION" ]] || exit 43 ;;
  'ecr get-login-password') echo test-login ;;
  'ecr describe-images') echo sha256:test-image ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, "docker"),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
if [[ "$1" == login ]]; then cat >/dev/null; fi
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [resolve("scripts/deploy.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      CALL_LOG: log,
      FAIL_FUNCTION: failFunction,
      AWS_REGION: "us-east-1",
      MORK_ACCOUNT: "123456789012",
      MORK_NAME: "test_mork",
      MORK_ECR_PREFIX: "",
      MORK_FUNCTIONS: "",
      ALLOW_DIRTY: "1",
    },
  });
  return { ...result, calls: readFileSync(log, "utf8") };
}

test("initial image upload normalizes ECR names and never calls Lambda", () => {
  const result = deploy(["--images-only"]);
  expect(result.status).toBe(0);
  expect(result.calls).toContain("/test-mork-runner:");
  expect(result.calls).toContain("/test-mork-egress:");
  expect(result.calls).toContain("/test-mork-lambda:");
  expect(result.calls).not.toContain("aws lambda");
});

test("regular deploy validates all functions before uploading and pins the Lambda digest", () => {
  const result = deploy([]);
  expect(result.status).toBe(0);
  expect(result.calls.indexOf("lambda get-function --function-name test_mork_slack")).toBeLessThan(result.calls.indexOf("docker build"));
  expect(result.calls).toContain(
    "lambda update-function-code --function-name test_mork_steps --image-uri 123456789012.dkr.ecr.us-east-1.amazonaws.com/test-mork-lambda@sha256:test-image",
  );
});

test("an unavailable function fails before any Docker or ECR side effect", () => {
  const result = deploy([], "test_mork_intake");
  expect(result.status).toBe(43);
  expect(result.calls).not.toContain("docker");
  expect(result.calls).not.toContain("aws ecr");
});
