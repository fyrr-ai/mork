import { expect, spyOn, test } from "bun:test";
import { GitHub } from "./github.ts";

test("commit titles use a repository-scoped request and only its first line", async () => {
  const original = globalThis.fetch;
  const repo = "o/r";
  const sha = "b".repeat(40);
  let message = "docs(readme): link config\n\nDetails about the change.";
  const transport = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) !== `https://api.github.com/repos/${repo}/commits/${sha}`) return original(input, init);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
    return Response.json({ commit: { message } });
  });
  try {
    const github = new GitHub(async (requestedRepo) => {
      expect(requestedRepo).toBe(repo);
      return "fixture-token";
    });
    expect(await github.commitTitle(repo, sha)).toBe("docs(readme): link config");
    message = "\nOnly a body, no subject";
    await expect(github.commitTitle(repo, sha)).rejects.toThrow();
  } finally {
    transport.mockRestore();
  }
});
