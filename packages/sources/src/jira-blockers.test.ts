import { expect, test } from "bun:test";
import { Jira } from "./jira.ts";

test("Jira reads only incoming Blocks and refreshes their status on every read", async () => {
  let done = false;
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requested.push(url.searchParams.get("fields") ?? "");
      return Response.json({
        key: "PROJ-2",
        fields: {
          summary: "Vendor",
          description: null,
          issuelinks: [
            {
              type: { name: "Blocks", inward: "is blocked by" },
              inwardIssue: {
                key: "PROJ-1",
                fields: { status: { name: done ? "Done" : "In Progress", statusCategory: { key: done ? "done" : "indeterminate" } } },
              },
            },
            { type: { name: "Blocks" }, outwardIssue: { key: "PROJ-3" } },
            { type: { name: "Relates" }, inwardIssue: { key: "PROJ-4" } },
            { type: { name: "Blocks" }, inwardIssue: { key: "PROJ-5" } },
          ],
        },
      });
    },
  });
  try {
    const jira = new Jira(server.url.toString(), "bot", "test-token");
    expect((await jira.issue("PROJ-2")).blocked_by).toEqual([
      { key: "PROJ-1", status: "In Progress", done: false },
      { key: "PROJ-5", status: "Unknown", done: false },
    ]);
    done = true;
    expect((await jira.issue("PROJ-2")).blocked_by?.[0]?.done).toBe(true);
    expect(requested.every((fields) => fields.split(",").includes("issuelinks"))).toBe(true);
  } finally {
    server.stop(true);
  }
});
