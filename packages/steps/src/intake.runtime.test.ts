import { expect, test } from "bun:test";

test("signed CI completions recheck each delivery idempotently and resume still requires write permission", async () => {
  const starts: { name: string; input: string }[] = [];
  const unexpected: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const target = req.headers.get("x-amz-target");
      if (target === "DynamoDB_20120810.GetItem") {
        return Response.json({ Item: { kind: { S: "link" }, task: { S: "o/r#1/abc" }, prefix: { S: "tasks/o/r/1/abc" } } });
      }
      if (target === "AWSStepFunctions.StartExecution") {
        const body = (await req.json()) as { name: string; input: string };
        starts.push(body);
        return Response.json({ executionArn: `arn:execution:${body.name}`, startDate: 1 });
      }
      if (url.pathname === "/repos/o/r/collaborators/reader/permission") return Response.json({ permission: "read" });
      unexpected.push(`${req.method} ${url.pathname} ${target ?? ""}`);
      return new Response("Unexpected request", { status: 400 });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    const child = Bun.spawn(
      [
        "bun",
        "--eval",
        `
      import {createHmac} from "node:crypto";
      const original = globalThis.fetch;
      globalThis.fetch = (url, init) => original(String(url).replace("https://api.github.com", ${JSON.stringify(endpoint)}), init);
      const {handler} = await import(${JSON.stringify(new URL("./intake.ts", import.meta.url).pathname)});
      async function send(kind, delivery, payload) {
        const body = JSON.stringify({repository:{full_name:"o/r"}, ...payload});
        const response = await handler({body, requestContext:{http:{method:"POST",path:"/"}},headers:{
          "x-github-event":kind,"x-github-delivery":delivery,
          "x-hub-signature-256":"sha256="+createHmac("sha256","fixture-secret").update(body).digest("hex")}});
        if(response.statusCode !== 202) throw new Error("Unexpected intake result");
      }
      const suite = conclusion => ({action:"completed",check_suite:{conclusion,head_sha:"c".repeat(40),head_branch:"mork/issue-1-abc",pull_requests:[{number:7}]}});
      await send("check_suite","delivery-a",suite("failure"));
      await send("check_suite","delivery-a",suite("failure"));
      await send("check_suite","delivery-b",suite("success"));
      await send("issue_comment","delivery-c",{action:"created",sender:{login:"reader"},issue:{number:7,pull_request:{}},comment:{id:8,body:"@mork resume",user:{login:"reader"}}});
    `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          AWS_REGION: "eu-west-1",
          AWS_ACCESS_KEY_ID: "local",
          AWS_SECRET_ACCESS_KEY: "local",
          AWS_ENDPOINT_URL: endpoint,
          MORK_TIMELINE_TABLE: "local",
          STATE_MACHINE_ARN: "arn:aws:states:eu-west-1:123456789012:stateMachine:local",
          REPO_ALLOWLIST: "o/r",
          GITHUB_TOKEN: "fixture-token",
          WEBHOOK_SECRET: "fixture-secret",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect(code, stderr).toBe(0);
    expect(unexpected).toEqual([]);
    expect(starts).toHaveLength(3);
    expect(starts[0]?.name).toBe(starts[1]?.name);
    expect(starts[2]?.name).not.toBe(starts[0]?.name);
    expect(starts.map((start) => JSON.parse(start.input).fix.trigger)).toEqual(Array(3).fill({ kind: "ci", sha: "c".repeat(40) }));
  } finally {
    server.stop(true);
  }
});
