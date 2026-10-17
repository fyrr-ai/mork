// Runs inside the final images, with networking disabled except container loopback.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.arch, process.argv[2] === "lambda" ? "x64" : "arm64", "Final runtime architecture must match its ECS/Lambda configuration");

if (process.argv[2] === "lambda") {
  for (const path of ["/bin/sh", "/bin/bash", "/usr/bin/apt", "/usr/local/bin/npm", "/var/runtime/node_modules"]) {
    assert.equal(existsSync(path), false, `Unneeded Lambda path: ${path}`);
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: "url_verification", challenge: "bundled-lambda-works" });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const appBody = JSON.stringify({
    action: "labeled",
    label: { name: "mork" },
    repository: { full_name: "example-org/mork" },
    issue: { number: 1 },
    sender: { login: "tomsej", type: "User" },
  });
  const cases = [
    {
      handler: "packages/steps/lambda-intake.handler",
      event: { requestContext: { http: { method: "POST", path: "/" } }, body: "{}" },
      environment: { WEBHOOK_SECRET: "image-test-secret", GITHUB_TOKEN: "image-test-token" },
      expected: { statusCode: 401 },
    },
    {
      handler: "packages/sources/lambda-slack.handler",
      event: {
        requestContext: { http: { method: "POST", path: "/" } },
        body,
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${createHmac("sha256", "image-test-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`,
        },
      },
      environment: { SLACK_SIGNING_SECRET: "image-test-secret", SLACK_BOT_TOKEN: "image-test-token" },
      expected: { statusCode: 200, headers: { "content-type": "text/plain" }, body: "bundled-lambda-works" },
    },
    {
      handler: "packages/steps/lambda-steps.handler",
      event: { action: "start" },
      environment: {},
      error: "GITHUB_TOKEN or GITHUB_APP is required",
    },
    {
      handler: "packages/steps/lambda-intake.handler",
      event: {
        requestContext: { http: { method: "POST", path: "/" } },
        body: appBody,
        headers: {
          "x-github-event": "issues",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "image-test-secret").update(appBody).digest("hex")}`,
        },
      },
      environment: {
        WEBHOOK_SECRET: "image-test-secret",
        REPO_ALLOWLIST: "example-org/mork",
        GITHUB_APP: JSON.stringify({
          appId: "12345",
          installationId: 99,
          privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
        }),
      },
      expected: { statusCode: 202 },
      app: true,
    },
  ];
  for (const test of cases) {
    let delivered = false;
    let minted = false;
    let authenticated = false;
    let finish: (value: { path: string; body: any }) => void;
    const answer = new Promise<{ path: string; body: any }>((resolve) => {
      finish = resolve;
    });
    const server = createServer(async (request, response) => {
      if (request.url === "/2018-06-01/runtime/invocation/next") {
        if (delivered) return;
        delivered = true;
        response.writeHead(200, {
          "content-type": "application/json",
          "lambda-runtime-aws-request-id": "image-test",
          "lambda-runtime-deadline-ms": String(Date.now() + 30_000),
          "lambda-runtime-invoked-function-arn": "arn:aws:lambda:eu-west-1:123456789012:function:image-test",
        });
        response.end(JSON.stringify(test.event));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      if (test.app && request.url === "/app/installations/99/access_tokens") {
        const [header, payload, signature] = (request.headers.authorization ?? "").slice(7).split(".");
        assert(header && payload && signature);
        assert(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
        assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).iss, "12345");
        assert.deepEqual(JSON.parse(body), { repositories: ["mork"] });
        minted = true;
        response
          .writeHead(201, { "content-type": "application/json" })
          .end(JSON.stringify({ token: "ghs-image-app-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
        return;
      }
      if (test.app && request.url === "/repos/example-org/mork/collaborators/tomsej/permission") {
        assert.equal(request.headers.authorization, "Bearer ghs-image-app-token");
        authenticated = true;
        response.writeHead(200, { "content-type": "application/json" }).end('{"role_name":"read"}');
        return;
      }
      response.writeHead(202).end();
      finish({ path: request.url ?? "", body: body ? JSON.parse(body) : null });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const hook = "/tmp/mork-app-fetch.mjs";
    if (test.app)
      writeFileSync(
        hook,
        `const original = globalThis.fetch; globalThis.fetch = (input, init) => { const url = new URL(String(input)); if (url.hostname === 'api.github.com') { url.protocol = 'http:'; url.host = '127.0.0.1:${address.port}'; } return original(url, init); };`,
      );
    const child = spawn(process.execPath, ["/var/runtime/entrypoint.mjs", test.handler], {
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp",
        NODE_OPTIONS: test.app ? `--import=${hook}` : "",
        AWS_REGION: "eu-west-1",
        AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${address.port}`,
        AWS_LAMBDA_FUNCTION_NAME: "image-test",
        AWS_LAMBDA_FUNCTION_VERSION: "$LATEST",
        AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "512",
        AWS_LAMBDA_LOG_GROUP_NAME: "/aws/lambda/image-test",
        AWS_LAMBDA_LOG_STREAM_NAME: "image-test",
        LAMBDA_TASK_ROOT: "/var/task",
        LAMBDA_RUNTIME_DIR: "/var/runtime",
        ...test.environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const exited = new Promise<never>((_, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => reject(new Error(`Lambda exited ${code}/${signal}: ${output}`)));
    });
    try {
      const result = await Promise.race([answer, exited]);
      if (test.error) {
        assert.equal(result.path, "/2018-06-01/runtime/invocation/image-test/error");
        assert.equal(result.body.errorMessage, test.error);
      } else {
        assert.equal(result.path, "/2018-06-01/runtime/invocation/image-test/response", JSON.stringify(result.body));
        assert.deepEqual(result.body, test.expected);
      }
      console.log(`Lambda Runtime API passed: ${test.handler}`);
      if (test.app) {
        assert(minted && authenticated);
        console.log("Compiled GitHub App intake passed: JWT signature, scoped token and authenticated permission check");
      }
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  // A signed mention is acknowledged before any Jev call. Exercise the
  // compiled worker too, with every remote endpoint redirected to loopback.
  const routingObjects = new Map<string, string>();
  let queued: any;
  let jevCalls = 0;
  let started: any;
  const routingServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const path = decodeURIComponent((request.url ?? "").split("?")[0] ?? "");
    if (path.startsWith("/2015-03-31/functions/")) {
      queued = JSON.parse(text);
      response.writeHead(202).end();
    } else if (path.startsWith("/routing-test/")) {
      if (request.method === "PUT") {
        routingObjects.set(path, text);
        response.writeHead(200, { etag: '"fixture"' }).end();
      } else if (routingObjects.has(path)) response.writeHead(200).end(routingObjects.get(path));
      else response.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
    } else if (path === "/v1/systemone") {
      jevCalls++;
      const body = JSON.parse(text);
      assert.deepEqual(Object.keys(body.questions.workflow.criteria), ["analysis", "backup", "_clarify"]);
      response
        .writeHead(200)
        .end(JSON.stringify({ answers: { workflow: { choice: "analysis", confidence: 0.99, probabilities: { analysis: 0.99 } } } }));
    } else if (request.headers["x-amz-target"] === "AWSStepFunctions.StartExecution") {
      started = JSON.parse(text);
      response
        .writeHead(200, { "content-type": "application/x-amz-json-1.0" })
        .end(JSON.stringify({ executionArn: "arn:aws:states:us-east-1:123456789012:execution:mork_analysis:slack-EvWORKFLOW", startDate: 0 }));
    } else response.writeHead(200).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => routingServer.listen(0, "127.0.0.1", resolve));
  const routingAddress = routingServer.address();
  assert(routingAddress && typeof routingAddress !== "string");
  const routingBase = `http://127.0.0.1:${routingAddress.port}`;
  routingObjects.set(
    "/routing-test/config/slack.json",
    JSON.stringify({
      channels: { CDEMO: { default_workflow: "analysis", allowed_workflows: ["analysis", "backup"] } },
      workflows: {
        analysis: { arn: "arn:aws:states:us-east-1:123456789012:stateMachine:mork_analysis", kind: "configured", description: "Analyze numbers" },
        backup: { arn: "arn:aws:states:us-east-1:123456789012:stateMachine:mork_backup", kind: "configured", description: "Back up data" },
      },
    }),
  );
  Object.assign(process.env, {
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "fixture",
    AWS_SECRET_ACCESS_KEY: "fixture",
    AWS_ENDPOINT_URL: routingBase,
    AWS_ENDPOINT_URL_LAMBDA: routingBase,
    AWS_ENDPOINT_URL_S3: routingBase,
    AWS_ENDPOINT_URL_SFN: routingBase,
    SLACK_SIGNING_SECRET: "fixture-signing",
    SLACK_BOT_TOKEN: "fixture-bot",
    JEV_API: "fixture-jev",
    TYPESAFE_BASE_URL: routingBase,
    MORK_BUCKET: "routing-test",
    SLACK_CONFIG_KEY: "config/slack.json",
    MORK_SLACK_FUNCTION_NAME: "mork_slack",
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    return realFetch(url.startsWith("https://slack.com/api/") ? `${routingBase}/${url.split("/api/")[1]}` : input, init);
  }) as typeof fetch;
  try {
    const { handler } = await import("/var/task/packages/sources/lambda-slack.mjs");
    const ts = String(Math.floor(Date.now() / 1000));
    const mention = JSON.stringify({
      type: "event_callback",
      event_id: "EvWORKFLOW",
      event: { type: "app_mention", user: "U1", channel: "CDEMO", ts: "1.0", text: "<@UAGENT> analysis add 20 and 22" },
    });
    const acknowledged = await handler({
      requestContext: { http: { method: "POST" } },
      body: mention,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${createHmac("sha256", "fixture-signing").update(`v0:${ts}:${mention}`).digest("hex")}`,
      },
    });
    assert.equal(acknowledged.statusCode, 200);
    assert.equal(jevCalls, 0, "The webhook must not wait for Jev");
    assert.equal(queued.action, "slack.mention");
    await handler(queued);
    assert.equal(jevCalls, 1);
    assert.equal(started.stateMachineArn, "arn:aws:states:us-east-1:123456789012:stateMachine:mork_analysis");
    assert.equal(JSON.parse(started.input).workflow, "analysis");
    const storedConfig = routingObjects.get("/routing-test/config/slack.json");
    assert(storedConfig);
    const single = JSON.parse(storedConfig);
    single.channels.CDEMO.allowed_workflows = ["analysis"];
    routingObjects.set("/routing-test/config/slack.json", JSON.stringify(single));
    await handler({ ...queued, request: { ...queued.request, event_id: "EvSINGLE", ref: { ...queued.request.ref, thread_ts: "2.0" } } });
    assert.equal(jevCalls, 1, "The sole workflow must not call Jev");
    assert.equal(started.name, "slack-EvSINGLE");
    assert.equal(JSON.parse(started.input).workflow, "analysis");
    console.log("Compiled Slack webhook passed: asynchronous acknowledgement, sole workflow and Jev selection between workflows");
  } finally {
    globalThis.fetch = realFetch;
    routingServer.closeAllConnections();
    await new Promise<void>((resolve) => routingServer.close(() => resolve()));
  }
} else if (process.argv[2] === "runner") {
  const root = "/opt/mork/packages/runner";
  const { PiRpc } = await import(pathToFileURL(`${root}/src/rpc.ts`).href);
  const dir = mkdtempSync(join(tmpdir(), "mork-pi-image-"));
  chownSync(dir, 10001, 10001);
  writeFileSync(
    join(dir, "verify.json"),
    JSON.stringify({
      repo: { full_name: "fixture/repo", default_branch: "main", base_sha: "a".repeat(40) },
      config: { test: "true", checks: [], test_paths: [], protected_paths: [] },
      setupMarker: join(dir, "setup.done"),
    }),
  );
  const toolRegistry = join(dir, "registered-tools.json");
  const toolProbe = join(dir, "tool-probe.ts");
  writeFileSync(
    toolProbe,
    `import {writeFileSync} from 'node:fs'; export default function(pi) { pi.on('session_start', () => { writeFileSync(${JSON.stringify(toolRegistry)}, JSON.stringify(pi.getAllTools().map(tool => tool.name))); }); }`,
  );
  const session = join(dir, "session.jsonl");
  writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "image-test", timestamp: new Date().toISOString(), cwd: dir })}\n`);
  chownSync(session, 10001, 10001);
  const pi = new PiRpc({
    bin: "pi",
    args: [
      "--session",
      session,
      "--no-extensions",
      "--no-skills",
      ...["guard", "submit", "dir-rules", "ask", "verify"].flatMap((name) => ["-e", `${root}/extensions/${name}.ts`]),
      "-e",
      toolProbe,
    ],
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: "/home/agent",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_DIR: join(dir, ".pi"),
      MORK_BASE_SHA: "a".repeat(40),
      MORK_OUTPUT: join(dir, "result.json"),
      MORK_QUESTION: join(dir, "question.txt"),
      MORK_VERIFY: join(dir, "verify.json"),
    },
    uid: 10001,
    gid: 10001,
  });
  try {
    const state = await pi.command({ type: "get_state" });
    assert.equal(state.success, true);
    assert.equal((await pi.command({ type: "get_commands" })).success, true);
    assert.equal(pi.stderrTail.includes("Failed to load extension"), false, pi.stderrTail);
    const registered = JSON.parse(readFileSync(toolRegistry, "utf8"));
    for (const tool of ["verify", "submit_result", "ask_human"]) assert(registered.includes(tool), `Pi did not register ${tool}`);
    const html = join(dir, "session.html");
    assert.equal((await pi.command({ type: "export_html", outputPath: html })).success, true);
    assert.equal(existsSync(html), true);
    console.log("Pi RPC and all five extensions passed as agent");
  } catch (error) {
    throw new Error(`Pi failed: ${pi.stderrTail}`, { cause: error });
  } finally {
    await pi.stop();
  }
  const exec = (command: string, args: string[], options: { uid?: number; gid?: number } = {}) => {
    const result = spawnSync(command, args, { encoding: "utf8", ...options });
    return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  for (const [command, args] of [
    ["git", ["--version"]],
    ["ocr", ["--version"]],
    ["bash", ["-c", "printf runner-tools"]],
    ["npm", ["--version"]],
    ["openssl", ["version"]],
    ["envsubst", ["--version"]],
    ["awk", ["BEGIN { if (2 + 3 != 5) exit 1; }"]],
    ["python3", ["-c", "import ssl, sqlite3, socket; from zoneinfo import ZoneInfo; ZoneInfo('Europe/Prague'); socket.getaddrinfo('localhost', 80)"]],
    ["python3", ["-c", "import ctypes; [ctypes.CDLL(name) for name in ('librt.so.1', 'libpthread.so.0', 'libdl.so.2', 'libutil.so.1')]"]],
    ["rg", ["--version"]],
    ["fd", ["--version"]],
  ])
    assert.equal(exec(command, args, { uid: 10001, gid: 10001 }).code, 0, command);
  // Exercise the bundled gate under the real sandbox uid.
  assert.equal(exec("bash", ["-c", "command -v mise || command -v uv"]).code, 1, "Generic worker proof requires no repository tool manager");
  const source = "/work/image-source";
  const work = "/work/image-gate";
  mkdirSync(source);
  mkdirSync(work);
  const git = (...args: string[]) => {
    const result = exec("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-C", source, ...args]);
    assert.equal(result.code, 0, result.output);
    return result.output.trim();
  };
  git("init", "-q");
  writeFileSync(join(source, "value.cjs"), "module.exports = 0;\n");
  mkdirSync(join(source, ".mork"));
  const repositoryConfig = 'test = "node --check value.cjs"\n';
  writeFileSync(join(source, ".mork/config.toml"), repositoryConfig);
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "mork/image-test");
  writeFileSync(join(source, "value.cjs"), "module.exports = 1;\n");
  git("commit", "-qam", "fix");
  const { runGate } = await import(pathToFileURL(`${root}/src/gate.ts`).href);
  const runtimeDirectory = "/opt/mork-runtime";
  mkdirSync(runtimeDirectory);
  const runtimeManifest = {
    schema: 1,
    platform: "linux/arm64",
    base_mork_digest: `sha256:${"1".repeat(64)}`,
    inputs: { ".mork/config.toml": "0".repeat(64) },
  };
  writeFileSync(join(runtimeDirectory, "manifest.json"), JSON.stringify(runtimeManifest));
  await assert.rejects(
    runGate(
      {
        mode: "after",
        repo: { full_name: "fixture/repo", default_branch: "main", base_sha: base },
        branch: "mork/image-test",
        localRepo: source,
        config: {
          setup: "exit 97",
          test: "true",
          checks: [],
          test_paths: [],
          protected_paths: [],
          hidden_tests: { dir: "hidden", command: "bash {file}", file_suffix: ".sh" },
        },
        hidden_tests: [],
        allow_test_change: false,
      },
      "",
      work,
      { uid: 10002, gid: 10002, env: { PATH: process.env.PATH, HOME: "/home/sandbox" } },
    ),
    /Prepared runtime input does not match/,
  );
  runtimeManifest.inputs[".mork/config.toml"] = createHash("sha256").update(repositoryConfig).digest("hex");
  writeFileSync(join(runtimeDirectory, "manifest.json"), JSON.stringify(runtimeManifest));
  const result = await runGate(
    {
      mode: "after",
      repo: { full_name: "fixture/repo", default_branch: "main", base_sha: base },
      branch: "mork/image-test",
      localRepo: source,
      allow_test_change: false,
      config: {
        setup: "! sh -c 'echo tampered > value.cjs' && ! rm value.cjs && mkdir generated",
        test: "node --check value.cjs",
        checks: ["test -d generated"],
        test_paths: [],
        protected_paths: [],
        hidden_tests: { dir: "hidden", command: "bash {file}", file_suffix: ".sh" },
      },
      hidden_tests: [{ file: "value.sh", criteria: ["AC1"], content: `node -e "process.exit(require('./value.cjs') === 1 ? 0 : 1)"` }],
    },
    "",
    work,
    { uid: 10002, gid: 10002, env: { PATH: process.env.PATH, HOME: "/home/sandbox" } },
  );
  assert.equal(result.setup.exit_code, 0);
  assert.equal(result.repo_tests.exit_code, 0);
  assert.equal(result.hidden[0].passed, true);
  rmSync(runtimeDirectory, { recursive: true });
  console.log("Bundled gate, generic runtime manifest and checkout protection passed without mise or uv as sandbox");
  assert.equal(existsSync("/usr/bin/apt"), false);
  assert.equal(existsSync("/usr/bin/dpkg"), false);
  assert.equal(existsSync("/root/.npm"), false);
  // Photon is an explicit external dependency of Pi's bundled image worker.
  const { createRequire } = await import("node:module");
  const requirePi = createRequire("/opt/pi/package.json");
  const photon = requirePi("@silvia-odwyer/photon-node");
  const image = photon.PhotonImage.new_from_base64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  );
  assert.equal(image.get_width(), 1);
  assert.equal(image.get_height(), 1);
  image.free();
  console.log("Runner tools and Photon passed");
} else throw new Error("Expected runner or lambda");
