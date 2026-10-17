import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, mustExec } from "./git.ts";
import { hydrateInputs } from "./inputs.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mork-inputs-"));
  roots.push(root);
  const repo = join(root, "source");
  mkdirSync(repo);
  const git = (...args: string[]) => mustExec("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  mkdirSync(join(repo, "schema"));
  writeFileSync(join(repo, "schema", "ticket.sql"), "CREATE TABLE ticket (id bigint);\n");
  writeFileSync(join(repo, "other.txt"), "unselected");
  git("add", ".");
  git("commit", "-qm", "initial");
  const sha = git("rev-parse", "HEAD").trim();
  return { root, repo, git, sha, directory: join(root, "inputs") };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("hydrates pinned references and large answers as immutable files with a compact manifest", async () => {
  const f = fixture();
  const body = "historical schema\n".repeat(8000);
  const options = {
    directory: f.directory,
    answers: [{ question: "Schema?", answer: body, by: "requester" }],
    references: [{ name: "reference-data", repo: "example-org/reference-data", sha: f.sha, paths: ["schema"] }],
    token: async () => {
      throw new Error("local source must not mint a token");
    },
    localRepositories: { "example-org/reference-data": f.repo },
  };
  const first = await hydrateInputs(options);
  const manifest = JSON.parse(readFileSync(join(first.roots[0], "manifest.json"), "utf8"));
  expect(first.prompt.length).toBeLessThan(3000);
  expect(first.prompt).not.toContain(body);
  expect(readFileSync(join(first.roots[0], "answers/001.json"), "utf8")).toContain("historical schema");
  expect(JSON.parse(readFileSync(join(first.roots[0], "answers/001.json"), "utf8")).answer).toBe(body);
  expect(readFileSync(join(first.roots[0], "references/reference-data/schema/ticket.sql"), "utf8")).toContain("CREATE TABLE");
  expect(manifest.files.some((x: { path: string }) => x.path.endsWith("other.txt"))).toBe(false);
  expect(statSync(join(first.roots[0], "references/reference-data/schema/ticket.sql")).mode & 0o222).toBe(0);
  writeFileSync(join(f.repo, "schema/ticket.sql"), "changed working tree");
  const again = await hydrateInputs(options);
  expect(again).toEqual(first);
  expect(readFileSync(join(again.roots[0], "references/reference-data/schema/ticket.sql"), "utf8")).toContain("CREATE TABLE");
});

test("missing paths and symlink references fail preflight without following external files", async () => {
  const f = fixture();
  const base = { directory: f.directory, answers: [], token: async () => "unused", localRepositories: { "example-org/reference-data": f.repo } };
  await expect(
    hydrateInputs({ ...base, references: [{ name: "reference-data", repo: "example-org/reference-data", sha: f.sha, paths: ["missing.sql"] }] }),
  ).rejects.toThrow("missing.sql");
  symlinkSync("/etc/passwd", join(f.repo, "escape"));
  f.git("add", ".");
  f.git("commit", "-qm", "symlink");
  await expect(
    hydrateInputs({
      ...base,
      references: [{ name: "reference-data", repo: "example-org/reference-data", sha: f.git("rev-parse", "HEAD").trim(), paths: ["escape"] }],
    }),
  ).rejects.toThrow("regular file");
});

test("redacts known credentials before publishing answers or reference content", async () => {
  const f = fixture();
  const secret = "secret-value-for-test";
  const result = await hydrateInputs({
    directory: f.directory,
    answers: [{ question: "q", answer: secret }],
    references: [],
    token: async () => secret,
    secrets: () => [secret],
  });
  const answer = readFileSync(join(result.roots[0], "answers/001.json"), "utf8");
  expect(answer).not.toContain(secret);
  expect(answer).toContain("[redacted]");
});

test.skipIf(process.getuid?.() !== 0)("the worker can read exported references but cannot rewrite or replace them", async () => {
  const f = fixture();
  chmodSync(f.root, 0o755);
  const input = await hydrateInputs({
    directory: f.directory,
    answers: [{ question: "Format?", answer: "immutable contract" }],
    references: [],
    token: async () => "unused",
  });
  const file = join(input.roots[0], "answers/001.json");
  const worker = { uid: 10001, gid: 10001 };
  expect(exec("cat", [file], worker).output).toContain("immutable contract");
  expect(exec("bash", ["-c", 'printf modified > "$1"', "test", file], worker).code).not.toBe(0);
  expect(exec("rm", [file], worker).code).not.toBe(0);
  expect(exec("mv", [input.roots[0], `${input.roots[0]}-replaced`], worker).code).not.toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")).answer).toBe("immutable contract");
});

test("a cached manifest is parsed at the boundary: malformed shape, traversal and identity mismatch are refused", async () => {
  const f = fixture();
  const options = {
    directory: f.directory,
    answers: [{ question: "q", answer: "a" }],
    references: [{ name: "reference-data", repo: "example-org/reference-data", sha: f.sha, paths: ["schema"] }],
    token: async () => "unused",
    localRepositories: { "example-org/reference-data": f.repo },
  };
  const first = await hydrateInputs(options);
  const manifestPath = join(first.roots[0], "manifest.json");
  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original) as { identity: string; files: { path: string; sha256: string; bytes: number }[] };
  const rewrite = (value: unknown) => {
    chmodSync(first.roots[0], 0o755);
    chmodSync(manifestPath, 0o644);
    writeFileSync(manifestPath, typeof value === "string" ? value : JSON.stringify(value));
  };
  rewrite("{not json");
  await expect(hydrateInputs(options)).rejects.toThrow(/manifest/i);
  rewrite({ ...manifest, files: "nope" });
  await expect(hydrateInputs(options)).rejects.toThrow(/manifest/i);
  rewrite({ ...manifest, files: [{ ...manifest.files[0], path: "../../etc/passwd" }] });
  await expect(hydrateInputs(options)).rejects.toThrow(/manifest/i);
  rewrite({ ...manifest, files: [{ ...manifest.files[0], path: "/etc/passwd" }] });
  await expect(hydrateInputs(options)).rejects.toThrow(/manifest/i);
  rewrite({ ...manifest, files: [{ ...manifest.files[0], path: "notes/x.json" }] });
  await expect(hydrateInputs(options)).rejects.toThrow(/manifest/i);
  rewrite({ ...manifest, identity: "0".repeat(64) });
  await expect(hydrateInputs(options)).rejects.toThrow(/identity/i);
  rewrite({ ...manifest, files: [{ ...manifest.files[0], sha256: "0".repeat(64) }] });
  await expect(hydrateInputs(options)).rejects.toThrow(/hash/i);
  rewrite(original);
  expect(await hydrateInputs(options)).toEqual(first);
});

test("a cached input file replaced by a symlink is refused even when the link target hashes right", async () => {
  const f = fixture();
  const options = { directory: f.directory, answers: [{ question: "q", answer: "a" }], references: [], token: async () => "unused" };
  const first = await hydrateInputs(options);
  const file = join(first.roots[0], "answers", "001.json");
  const copy = join(f.root, "elsewhere.json");
  writeFileSync(copy, readFileSync(file));
  chmodSync(join(first.roots[0], "answers"), 0o755);
  rmSync(file);
  symlinkSync(copy, file);
  await expect(hydrateInputs(options)).rejects.toThrow(/regular file/i);
});

test("cached inputs reject symlinked parent directories before reading their files", async () => {
  const f = fixture();
  const options = { directory: f.directory, answers: [{ question: "q", answer: "a" }], references: [], token: async () => "unused" };
  const first = await hydrateInputs(options);
  const answers = join(first.roots[0], "answers");
  const external = join(f.root, "external-answers");
  renameSync(answers, external);
  symlinkSync(external, answers);
  await expect(hydrateInputs(options)).rejects.toThrow(/directory/i);
});

test("cached inputs reject a symlinked generation or manifest", async () => {
  const f = fixture();
  const options = { directory: f.directory, answers: [], references: [], token: async () => "unused" };
  const first = await hydrateInputs(options);
  const manifest = join(first.roots[0], "manifest.json");
  const externalManifest = join(f.root, "external-manifest.json");
  renameSync(manifest, externalManifest);
  symlinkSync(externalManifest, manifest);
  await expect(hydrateInputs(options)).rejects.toThrow(/regular file/i);
  rmSync(manifest);
  renameSync(externalManifest, manifest);
  const externalGeneration = join(f.root, "external-generation");
  renameSync(first.roots[0], externalGeneration);
  symlinkSync(externalGeneration, first.roots[0]);
  await expect(hydrateInputs(options)).rejects.toThrow(/directory/i);
});
