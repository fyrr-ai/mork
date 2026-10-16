import { describe, expect, test } from "bun:test";
import {
  authorCriteria,
  BRANCH_PATTERN,
  parseRepoConfig,
  publicFeedback,
  RuntimeManifest,
  raiseLevel,
  readPublicFeedback,
  repairFeedback,
  TaskRuntime,
} from "./index.ts";

describe("contracts", () => {
  test("repo config parses with defaults", () => {
    const c = parseRepoConfig(`test = "npm test"\n[hidden_tests]\ndir = "test/hidden"\ncommand = "node --test {file}"\nfile_suffix = ".test.mjs"\n`);
    expect(c.test_paths).toEqual(["test/", "tests/"]);
    expect(c.protected_paths).toEqual([]);
  });
  test("hidden test command must reference {file}", () => {
    expect(() => parseRepoConfig(`test = "x"\n[hidden_tests]\ndir = "d"\ncommand = "node --test"\nfile_suffix = ".t"\n`)).toThrow();
  });
  test("levels only rise", () => {
    expect(raiseLevel("quick", "careful")).toBe("careful");
    expect(raiseLevel("takeover", "quick")).toBe("takeover");
  });
  test("branch pattern refuses main, refs and metacharacters", () => {
    for (const b of ["main", "mork/../main", "refs/heads/mork/x", "mork/a;rm", "mork/A"]) expect(BRANCH_PATTERN.test(b)).toBe(false);
    expect(BRANCH_PATTERN.test("mork/issue-12-fix-reset")).toBe(true);
  });
  test("author criteria are numbered lines, however Jira renders the list", () => {
    const body = [
      "Goal: link the config.",
      "",
      "Acceptance criteria",
      "- AC1: README links  `.mork/config.toml`",
      "**AC2**: other README text is unchanged",
      "AC3 - CI passes",
      "We discussed AC4 later.",
    ].join("\n");
    expect(authorCriteria(body)).toEqual([
      { id: "AC1", text: "README links `.mork/config.toml`" },
      { id: "AC2", text: "other README text is unchanged" },
      { id: "AC3", text: "CI passes" },
    ]);
    expect(authorCriteria(null)).toEqual([]);
    expect(authorCriteria("- adds a link\n- keeps the rest")).toEqual([]);
  });
});

test("public feedback requires a leading marker and never upgrades legacy review findings", () => {
  expect(readPublicFeedback(publicFeedback("Public CI / review"))).toBe("Public CI / review");
  expect(readPublicFeedback(`ORACLE\n${publicFeedback("legacy")}`)).toContain("Legacy feedback withheld");
  expect(readPublicFeedback(`ORACLE\n${publicFeedback("legacy")}`)).not.toContain("ORACLE");
  expect(readPublicFeedback(repairFeedback([]))).toContain("Legacy reviewer feedback withheld");
  expect(readPublicFeedback(repairFeedback([], "public-v1"))).toContain("The reviewer found defects");
});

test("runtime identity accepts only an immutable ARM64 image and revision-qualified phase definitions", () => {
  const runtime = {
    image: `registry.example/app@sha256:${"1".repeat(64)}`,
    platform: "linux/arm64",
    repository_runtime: true,
    task_definitions: Object.fromEntries(
      ["plan", "build", "check"].map((phase) => [phase, `arn:aws:ecs:eu-west-1:123456789012:task-definition/mork_${phase}:7`]),
    ),
  };
  expect(TaskRuntime.safeParse(runtime).success).toBe(true);
  for (const changed of [
    { ...runtime, image: "registry.example/app:latest" },
    { ...runtime, platform: "linux/amd64" },
    { ...runtime, task_definitions: { ...runtime.task_definitions, build: "arn:aws:ecs:eu-west-1:123456789012:task-definition/mork_build" } },
    { ...runtime, task_definitions: { plan: runtime.task_definitions.plan } },
  ])
    expect(TaskRuntime.safeParse(changed).success).toBe(false);
  expect(
    RuntimeManifest.safeParse({
      schema: 1,
      platform: "linux/arm64",
      base_mork_digest: `sha256:${"1".repeat(64)}`,
      inputs: { "../secret": "2".repeat(64) },
    }).success,
  ).toBe(false);
});
