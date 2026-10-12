import { expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { Store } from "./index.ts";

// Local S3 protocol peer exercises the real SDK's conditional request headers.
function fixture(options: { initial?: unknown; raceReads?: boolean; conflictStatus?: number } = {}) {
  let body = options.initial === undefined ? undefined : JSON.stringify(options.initial);
  let version = 0;
  let reads = 0;
  const writes: { match: string | null; absent: string | null; body: string }[] = [];
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const failure = (status: number, code: string) =>
    new Response(`<Error><Code>${code}</Code><Message>fixture</Message></Error>`, { status, headers: { "content-type": "application/xml" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") {
        const snapshot = body;
        const etag = `"${version}"`;
        if (options.raceReads && ++reads <= 2) {
          if (reads === 2) releaseReads();
          await bothRead;
        }
        return snapshot === undefined ? failure(404, "NoSuchKey") : new Response(snapshot, { headers: { etag } });
      }
      if (request.method !== "PUT") return failure(405, "MethodNotAllowed");
      const next = await request.text();
      const match = request.headers.get("if-match");
      const absent = request.headers.get("if-none-match");
      writes.push({ match, absent, body: next });
      if (options.conflictStatus)
        return failure(options.conflictStatus, options.conflictStatus === 409 ? "ConditionalRequestConflict" : "PreconditionFailed");
      if ((absent === "*" && body !== undefined) || (match !== null && match !== `"${version}"`)) return failure(412, "PreconditionFailed");
      body = next;
      version++;
      return new Response(null, { headers: { etag: `"${version}"` } });
    },
  });
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${server.port}`,
    forcePathStyle: true,
    region: "fixture",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    maxAttempts: 1,
  });
  return {
    store: new Store("bucket", client),
    writes,
    value: () => (body === undefined ? undefined : JSON.parse(body)),
    stop: () => {
      client.destroy();
      server.stop();
    },
  };
}

test("JSON updates use conditional create and then the previous object's ETag", async () => {
  const t = fixture();
  try {
    await t.store.updateJson("answers", () => ["first"]);
    await t.store.updateJson("answers", (current) => [...(current as string[]), "second"]);
    expect(t.writes.map(({ match, absent }) => ({ match, absent }))).toEqual([
      { match: null, absent: "*" },
      { match: '"1"', absent: null },
    ]);
    expect(t.value()).toEqual(["first", "second"]);
  } finally {
    t.stop();
  }
});

test("two writers with the same snapshot retry a conflict and preserve both answers", async () => {
  const t = fixture({ initial: [], raceReads: true });
  try {
    await Promise.all(["first", "second"].map((answer) => t.store.updateJson("answers", (current) => [...(current as string[]), answer])));
    expect(t.value().sort()).toEqual(["first", "second"]);
    expect(t.writes).toHaveLength(3);
    expect(t.writes.filter((write) => write.match === '"0"')).toHaveLength(2);
    expect(t.writes.some((write) => write.match === '"1"')).toBe(true);
  } finally {
    t.stop();
  }
});

test("an unchanged JSON object avoids a write", async () => {
  const t = fixture({ initial: ["already delivered"] });
  try {
    await t.store.updateJson("answers", (current) => current);
    expect(t.writes).toEqual([]);
  } finally {
    t.stop();
  }
});

test("persistent conditional conflicts remain errors after a bounded retry", async () => {
  for (const conflictStatus of [409, 412]) {
    const t = fixture({ initial: [], conflictStatus });
    try {
      await expect(t.store.updateJson("answers", () => ["first"])).rejects.toThrow("did not converge");
      expect(t.writes).toHaveLength(8);
      expect(t.value()).toEqual([]);
    } finally {
      t.stop();
    }
  }
});

test("a 409 on conditional creation is an error, not evidence of an existing claim", async () => {
  const conflict = fixture({ conflictStatus: 409 });
  const existing = fixture({ initial: { owner: "first" } });
  try {
    await expect(conflict.store.claim("claim", { owner: "second" })).rejects.toMatchObject({ $metadata: { httpStatusCode: 409 } });
    expect(conflict.value()).toBeUndefined();
    expect(await existing.store.claim("claim", { owner: "second" })).toBe(false);
    expect(existing.value()).toEqual({ owner: "first" });
  } finally {
    conflict.stop();
    existing.stop();
  }
});

test("releasing a missing reservation never creates an empty S3 object", async () => {
  const t = fixture();
  try {
    await t.store.updateJson("pr.json", (current) => current);
    expect(t.writes).toEqual([]);
    expect(t.value()).toBeUndefined();
  } finally {
    t.stop();
  }
});
