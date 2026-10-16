import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deploy(args: string[], failFunction = "", failSoci = false, invalidSchema = false) {
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
  'ecr describe-images') printf 'sha256:%064d\\n' 0 ;;
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
  writeFileSync(
    join(root, "soci"),
    `#!/usr/bin/env bash
printf 'soci %s\\n' "$*" >> "$CALL_LOG"
[[ "$FAIL_SOCI" != 1 ]] || exit 44
destination="\${!#}"
digest="$(printf '1%.0s' {1..64})"
mkdir -p "$destination/blobs/sha256"
printf '{"manifests":[{"digest":"sha256:%s"}]}\\n' "$digest" > "$destination/index.json"
printf '{"manifests":[{"artifactType":"application/vnd.amazon.soci.index.v2+json"}]}\\n' > "$destination/blobs/sha256/$digest"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, "crane"),
    `#!/usr/bin/env bash
printf 'crane %s\\n' "$*" >> "$CALL_LOG"
if [[ "$1" == manifest ]]; then printf '{"manifests":[{"artifactType":"application/vnd.amazon.soci.index.v2+json"}]}\\n'; fi
`,
    { mode: 0o755 },
  );
  const fixturePlan = {
    planned_values: {
      root_module: {
        resources: [
          {
            type: "aws_ecs_task_definition",
            name: "phase",
            address: "module.mork.aws_ecs_task_definition.phase[plan]",
            values: {
              container_definitions: JSON.stringify([
                {
                  environment: [
                    {
                      name: invalidSchema ? "MORK_WORKFLOW_STEP" : "MORK_DEVELOPMENT_STEP",
                      value: JSON.stringify(
                        invalidSchema
                          ? { kind: "agent", name: "analyze", instructions: "Analyze", output_schema: { type: "object", requird: ["total"] } }
                          : { kind: "plan", name: "plan", instructions: "Plan" },
                      ),
                    },
                  ],
                },
              ]),
            },
          },
        ],
      },
    },
  };
  writeFileSync(join(root, "plan.json"), JSON.stringify(fixturePlan));
  writeFileSync(
    join(root, "tofu"),
    `#!/usr/bin/env bash
printf 'tofu %s\\n' "$*" >> "$CALL_LOG"
if [[ "$2" == show ]]; then cat "$(dirname "$CALL_LOG")/plan.json"; fi
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
      FAIL_SOCI: failSoci ? "1" : "0",
      AWS_REGION: "us-east-1",
      MORK_INFRA_DIR: root,
      MORK_ACCOUNT: "123456789012",
      MORK_NAME: "test_mork",
      MORK_ECR_PREFIX: "",
      MORK_FUNCTIONS: "",
      MORK_SOCI_BUILDER: "",
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
  for (const target of ["runner", "egress"]) expect(result.calls).toContain(`--platform linux/arm64 --provenance=false --target ${target}`);
  expect(result.calls).toContain("--platform linux/amd64 --provenance=false --target lambda");
  const builds = result.calls.split("\n").filter((line) => line.startsWith("docker build --quiet"));
  expect(builds).toHaveLength(3);
  expect(builds.every((line) => line.includes(" --load "))).toBe(true);
});

test("regular deploy validates all functions before uploading and applies immutable release inputs", () => {
  const result = deploy([]);
  expect(result.status).toBe(0);
  expect(result.calls.indexOf("lambda get-function --function-name test_mork_slack")).toBeLessThan(result.calls.indexOf("docker build"));
  expect(result.calls).not.toContain("lambda update-function-code");
  expect(result.calls).toContain("tofu -chdir=");
  const applyRoot = result.calls.match(/tofu -chdir=(\S+)/)?.[1];
  assert(applyRoot);
  expect(JSON.parse(readFileSync(join(applyRoot, ".mork-images.auto.tfvars.json"), "utf8"))).toEqual({
    image_digests: {
      runner: `sha256:${"0".repeat(64)}`,
      egress: `sha256:${"0".repeat(64)}`,
      lambda: `sha256:${"0".repeat(64)}`,
    },
  });
});

test("an unavailable function fails before any Docker or ECR side effect", () => {
  const result = deploy([], "test_mork_intake");
  expect(result.status).toBe(43);
  expect(result.calls).not.toContain("docker");
  expect(result.calls).not.toContain("aws ecr");
});

test("SOCI opt-in exports gzip OCI phase images while keeping Lambda a plain image", () => {
  const result = deploy(["--images-only", "--soci"]);
  expect(result.status).toBe(0);
  expect(result.calls).toContain("buildx build --platform linux/arm64 --provenance=false --target runner");
  expect(result.calls).toContain("buildx build --platform linux/arm64 --provenance=false --target egress");
  expect(result.calls).toContain("compression=gzip,force-compression=true");
  expect(result.calls.match(/soci convert --standalone --format oci-dir --platform linux\/arm64/g)).toHaveLength(2);
  expect(result.calls).toContain("crane tag 123456789012.dkr.ecr.us-east-1.amazonaws.com/test-mork-runner:");
  expect(result.calls).toContain("docker build --quiet --platform linux/amd64 --provenance=false --target lambda");
  expect(result.calls).not.toContain("crane tag 123456789012.dkr.ecr.us-east-1.amazonaws.com/test-mork-lambda:");
  expect(result.calls).not.toContain("aws lambda");
});

test("a failed SOCI conversion does not publish a moving tag or update Lambda", () => {
  const result = deploy(["--soci"], "", true);
  expect(result.status).toBe(44);
  expect(result.calls).not.toContain("crane push");
  expect(result.calls).not.toContain("crane tag");
  expect(result.calls).not.toContain("lambda update-function-code");
});

test("an untracked build input blocks deployment before AWS and Docker", () => {
  const root = mkdtempSync(join(tmpdir(), "mork-deploy-untracked-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "scripts/deploy.sh"), readFileSync("scripts/deploy.sh"));
  for (const args of [
    ["init", "-q", repo],
    ["-C", repo, "add", "."],
    ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"],
  ]) {
    expect(spawnSync("git", args).status).toBe(0);
  }
  expect(spawnSync("git", ["-C", repo, "diff", "--quiet", "HEAD"]).status).toBe(0);
  writeFileSync(join(repo, "untracked-build-input.ts"), "export const injected = true;");
  const log = join(root, "calls");
  writeFileSync(log, "");
  for (const command of ["aws", "docker"])
    writeFileSync(join(root, command), '#!/usr/bin/env bash\nprintf "called\\n" >> "$CALL_LOG"\n', { mode: 0o755 });
  const result = spawnSync("bash", [join(repo, "scripts/deploy.sh"), "--images-only"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      AWS_REGION: "us-east-1",
      MORK_INFRA_DIR: repo,
      ALLOW_DIRTY: "",
      CALL_LOG: log,
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("uncommitted or untracked files");
  expect(readFileSync(log, "utf8")).toBe("");
});

test("a semantically invalid planned schema blocks apply after upload", () => {
  const result = deploy([], "", false, true);
  expect(result.status).toBe(1);
  expect(result.calls).toContain("docker push");
  expect(result.calls).toContain(" show -json ");
  expect(result.calls).not.toMatch(/tofu[^\n]* apply /);
  expect(result.stderr).toContain("unknown keyword");
});
