import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("release export contains committed public content and no inherited history or ignored files", () => {
  const root = mkdtempSync(join(tmpdir(), "mork-export-"));
  roots.push(root);
  const source = join(root, "source");
  const destination = join(root, "public");
  mkdirSync(join(source, "scripts"), { recursive: true });
  copyFileSync(resolve("scripts/release-export.sh"), join(source, "scripts", "release-export.sh"));
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Private author", "-c", "user.email=private@example.test", "-c", "commit.gpgsign=false", "-C", source, ...args],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(source, "README.md"), "private-history-only\n");
  writeFileSync(join(source, ".gitignore"), ".env\n");
  writeFileSync(join(source, "package.json"), JSON.stringify({ version: "0.1.0" }));
  git("add", ".");
  git("commit", "-qm", "private import");
  git("branch", "internal");
  writeFileSync(join(source, "README.md"), "public-source\n");
  writeFileSync(join(source, ".env"), "ignored-local-settings\n");
  git("add", "README.md");
  git("commit", "-qm", "public tree");
  const missingIdentity = spawnSync("bash", [join(source, "scripts", "release-export.sh"), destination], {
    encoding: "utf8",
    env: { ...process.env, MORK_RELEASE_AUTHOR: "", MORK_RELEASE_EMAIL: "" },
  });
  expect(missingIdentity.status).not.toBe(0);
  expect(existsSync(destination)).toBe(false);
  const result = spawnSync("bash", [join(source, "scripts", "release-export.sh"), destination], {
    encoding: "utf8",
    env: { ...process.env, MORK_RELEASE_AUTHOR: "Public fixture", MORK_RELEASE_EMAIL: "fixture@example.invalid" },
  });
  expect(result.status).toBe(0);
  expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("public-source\n");
  expect(existsSync(join(destination, ".env"))).toBe(false);
  const exportedGit = (...args: string[]) => spawnSync("git", ["-C", destination, ...args], { encoding: "utf8" }).stdout.trim();
  expect(exportedGit("rev-list", "--all", "--count")).toBe("1");
  expect(exportedGit("branch", "--format=%(refname:short)")).toBe("main");
  expect(exportedGit("remote")).toBe("");
  expect(exportedGit("tag", "--list")).toBe("v0.1.0");
  expect(exportedGit("log", "--format=%ae")).toBe("fixture@example.invalid");
  expect(exportedGit("log", "--format=%ae")).not.toContain("private@example.test");
  const repeat = spawnSync("bash", [join(source, "scripts", "release-export.sh"), destination], { encoding: "utf8" });
  expect(repeat.status).toBe(1);
  expect(readFileSync(join(destination, "README.md"), "utf8")).toBe("public-source\n");
  expect(git("rev-list", "--all", "--count")).toBe("2");
});
