import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { type AnswerDeps, deliverAnswer } from "./answers.ts";
import { channelsFromEnv } from "./channels.ts";
import { allOf, slackSource } from "./index.ts";
import { adfToText, draftByRules, draftIssue, findIssueKey, Jira, textToAdf } from "./jira.ts";
import { executionUrl, grafanaLiveUrl, parseSlackRequest, Slack, slackSignatureValid, slackText, statusOf } from "./slack.ts";
import { asksForStatus, statusText, taskKey } from "./status.ts";
import { threadKey } from "./threads.ts";
import type { SlackStart } from "./types.ts";

const sign = (secret: string, ts: number, body: string) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
const mention = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "event_callback",
    event_id: "Ev0ABC123",
    event: { type: "app_mention", user: "U1", text, channel: "C0DEMO", ts: "1791631492.000100", ...extra },
  });

describe("slack intake", () => {
  const now = 1_791_631_500_000;
  const ts = Math.floor(now / 1000);
  test("accepts a fresh, correctly signed request", () => {
    expect(slackSignatureValid("s", "{}", String(ts), sign("s", ts, "{}"), now)).toBe(true);
  });
  test("rejects a wrong signature and a replayed timestamp", () => {
    expect(slackSignatureValid("s", "{}", String(ts), sign("other", ts, "{}"), now)).toBe(false);
    expect(slackSignatureValid("s", "{}", String(ts - 600), sign("s", ts - 600, "{}"), now)).toBe(false);
    expect(slackSignatureValid("s", "{}", undefined, undefined, now)).toBe(false);
  });
  test("answers the URL verification challenge", () => {
    expect(parseSlackRequest(JSON.stringify({ type: "url_verification", challenge: "abc" }))).toEqual({ kind: "challenge", challenge: "abc" });
  });
  test("a mention becomes a task in its own thread, mention stripped", () => {
    expect(parseSlackRequest(mention("<@U0AGENT> implement jira PROJ-123"))).toEqual({
      kind: "mention",
      event_id: "Ev0ABC123",
      ref: { kind: "slack", channel: "C0DEMO", thread_ts: "1791631492.000100", user: "U1" },
      ask: "implement jira PROJ-123",
      in_thread: false,
    });
  });
  test("a mention inside a thread answers in that thread", () => {
    const request = parseSlackRequest(mention("<@U0AGENT> add X", { thread_ts: "1791631000.000001" }));
    expect(request.kind === "mention" && request.ref.thread_ts).toBe("1791631000.000001");
  });
  test("bots and edits are ignored", () => {
    expect(parseSlackRequest(mention("<@U0AGENT> x", { bot_id: "B1" })).kind).toBe("ignored");
    expect(parseSlackRequest(mention("<@U0AGENT> x", { subtype: "message_changed" })).kind).toBe("ignored");
  });
  test("channels map to a repository and a Jira project", () => {
    const env = { SLACK_CHANNELS: JSON.stringify({ C0DEMO: { repo: "acme/widgets", jira_project: "DEMO" } }) };
    expect(channelsFromEnv(env).C0DEMO).toEqual({ repo: "acme/widgets", jira_project: "DEMO", jira_components: [] });
    expect(() => channelsFromEnv({ SLACK_CHANNELS: JSON.stringify({ C0DEMO: { repo: "no-slash", jira_project: "DEMO" } }) })).toThrow();
  });
});

describe("jira", () => {
  test("finds the issue key a request names", () => {
    expect(findIssueKey("please implement jira PROJ-123")).toBe("PROJ-123");
    expect(findIssueKey("add a CSV export")).toBeUndefined();
  });
  test("reads ADF descriptions as text", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Add truncate." }] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "max < 1 throws" }] }] }],
        },
      ],
    };
    expect(adfToText(adf).trim()).toBe("Add truncate.\n- max < 1 throws");
    expect(adfToText(textToAdf("one\n\ntwo")).trim()).toBe("one\ntwo");
  });
  test("without a usable model answer the rules decide Story or Bug", async () => {
    expect(draftByRules("Fix the export, it fails on an empty file").type).toBe("Bug");
    expect(draftByRules("Add a CSV export").type).toBe("Story");
    expect((await draftIssue("Add a CSV export", async () => "not json")).type).toBe("Story");
    const model = async () => '```json\n{"type":"Bug","summary":"Fix CSV export","description":"Empty files crash."}\n```';
    expect(await draftIssue("x", model)).toEqual({ type: "Bug", summary: "Fix CSV export", description: "Empty files crash." });
  });
});

describe("not a request", () => {
  test("no Jira issue is drafted when the drafting model says the message asks for nothing", async () => {
    expect(await draftIssue("what's up with the build?", async () => '{"type":"none"}')).toEqual({ type: "none" });
  });
  test("resolve tells the thread and creates nothing", async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    try {
      const source = slackSource(new Slack("xoxb"), new Jira("https://x.atlassian.net", "bot@x", "t"), async () => '{"type":"none"}');
      const ref = { kind: "slack" as const, channel: "C0DEMO", thread_ts: "1.2", user: "U1" };
      await expect(source.resolve({ repo: "o/r", source: "slack", ref, ask: "how are you today?", jira_project: "DEMO" })).rejects.toMatchObject({
        name: "NotARequest",
      });
      expect(urls.some((u) => u.includes("atlassian"))).toBe(false);
      expect(urls[0]).toBe("https://slack.com/api/chat.postMessage");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("reporting", () => {
  const work = { key: "DEMO-7", title: "Add truncate", body: "", url: "https://x.atlassian.net/browse/DEMO-7", created: true };
  test("updates are short, with a bold label and no emoji", () => {
    const arn = "arn:aws:states:eu-west-1:123456789012:execution:mork:slack-Ev1";
    expect(slackText({ kind: "started", work, execution_url: executionUrl(arn) })).toBe(
      "*Created <https://x.atlassian.net/browse/DEMO-7|DEMO-7>:* Add truncate\n<https://eu-west-1.console.aws.amazon.com/states/home?region=eu-west-1#/v2/executions/details/arn:aws:states:eu-west-1:123456789012:execution:mork:slack-Ev1|View the workflow run>",
    );
    expect(slackText({ kind: "started", work, live_url: "https://g/explore", execution_url: "https://aws/x" })).toBe(
      "*Created <https://x.atlassian.net/browse/DEMO-7|DEMO-7>:* Add truncate\n<https://g/explore|Live log in Grafana> · <https://aws/x|View the workflow run>",
    );
    const live = decodeURIComponent(grafanaLiveUrl("slack-Ev1", "https://grafana.example.com") ?? "");
    expect(grafanaLiveUrl("slack-Ev1", undefined)).toBeUndefined();
    expect(live.startsWith("https://grafana.example.com/explore?schemaVersion=1&orgId=1&panes=")).toBe(true);
    expect(live).toContain('{service_name=\\"mork\\"} | mork_execution=\\"slack-Ev1\\"');
    expect(slackText({ kind: "plan", criteria: 5, hidden_tests: 1 })).toBe("*Plan ready:* 5 acceptance criteria, 1 hidden test");
    expect(slackText({ kind: "build", attempt: 2, max: 3 })).toBe("*Implementing:* attempt 2 of 3");
    expect(
      slackText({ kind: "built", attempt: 1, branch: "factory/PROJ-9-ab", branch_url: "https://github.com/o/r/tree/factory/PROJ-9-ab", files: 3 }),
    ).toBe("*Pushed:* <https://github.com/o/r/tree/factory/PROJ-9-ab|factory/PROJ-9-ab> (3 files changed), running checks");
    expect(slackText({ kind: "check", attempt: 1, passed: false, failures: ["AC2 not met"] })).toBe("*Checks failed* (attempt 1)\n• AC2 not met");
    expect(
      slackText({ kind: "pr", url: "https://github.com/o/r/pull/27", level: "quick", reasons: ["Decision model (jev): quick with confidence 1.00"] }),
    ).toBe(
      "*Draft PR ready:* <https://github.com/o/r/pull/27|o/r#27>\n*Recommendation:* a quick look is enough\n• Decision model (jev): quick with confidence 1.00",
    );
    expect(
      slackText({ kind: "pr", url: "https://github.com/o/r/pull/27", level: "careful", reasons: [], transcripts_url: "https://console/s3/x" }),
    ).toBe("*Draft PR ready:* <https://github.com/o/r/pull/27|o/r#27>\n*Recommendation:* review carefully\n<https://console/s3/x|Agent transcripts>");
    expect(slackText({ kind: "handover", reason: "Tests failed.\n\ndetail" })).toBe("*Handed over to a person:* Tests failed.");
  });
  test("one failing target does not fail the others", async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const reporter = allOf([{ report: async () => Promise.reject(new Error("slack down")) }, { report: async (e) => void seen.push(e.kind) }], (e) =>
      errors.push(e),
    );
    await reporter.report({ kind: "plan", criteria: 3 });
    expect(seen).toEqual(["plan"]);
    expect(errors).toHaveLength(1);
  });
});

describe("slack source", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const input: SlackStart = {
    repo: "acme/widgets",
    source: "slack",
    ref: { kind: "slack", channel: "C0DEMO", thread_ts: "1791631492.000100", user: "U1" },
    ask: "add truncate(text, max)",
    jira_project: "DEMO",
  };
  const source = () => slackSource(new Slack("xoxb"), new Jira("https://x.atlassian.net/", "bot@x", "t"));

  test("a request without a key creates an issue in the channel's project", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ key: "DEMO-8" }, { status: 201 });
    }) as unknown as typeof fetch;
    const work = await source().resolve(input);
    expect(work).toMatchObject({ key: "DEMO-8", created: true, url: "https://x.atlassian.net/browse/DEMO-8", title: "add truncate(text, max)" });
    expect(calls[0]?.url).toBe("https://x.atlassian.net/rest/api/3/issue");
    expect(calls[0]?.body).toMatchObject({ fields: { project: { key: "DEMO" }, issuetype: { name: "Story" } } });
    expect((calls[0]?.body as { fields: Record<string, unknown> }).fields.components).toBeUndefined();
  });
  test("a channel's components go on the new issue", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ key: "PROJ-9" }, { status: 201 });
    }) as unknown as typeof fetch;
    await source().resolve({ ...input, jira_project: "PROJ", jira_components: ["PROJ"] });
    expect(calls[0]).toMatchObject({ fields: { project: { key: "PROJ" }, components: [{ name: "PROJ" }] } });
  });
  test("a request naming a key reads that issue", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ key: "PROJ-123", fields: { summary: "Add truncate", description: textToAdf("Exactly max chars.") } }),
    ) as unknown as typeof fetch;
    const work = await source().resolve({ ...input, ask: "implement PROJ-123" });
    expect(work).toEqual({
      key: "PROJ-123",
      title: "Add truncate",
      body: "Exactly max chars.",
      url: "https://x.atlassian.net/browse/PROJ-123",
      created: false,
    });
  });
});

describe("reporter before the Jira issue exists", () => {
  test("reports only into the Slack thread", async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    try {
      const source = slackSource(new Slack("xoxb"), new Jira("https://x.atlassian.net", "bot@x", "t"));
      const ref = { kind: "slack" as const, channel: "C0DEMO", thread_ts: "1791631492.000100", user: "U1" };
      await source
        .reporter({ repo: "o/r", source: "slack", ref, ask: "x", jira_project: "DEMO" })
        .report({ kind: "handover", reason: "Jira is down." });
      expect(urls[0]).toBe("https://slack.com/api/chat.postMessage");
      expect(urls.slice(1).every((u) => u.startsWith("https://slack.com/api/reactions."))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("status reaction", () => {
  test("follows the task: working, checking, ready for review or handed over", () => {
    expect(statusOf({ kind: "plan", criteria: 3 })).toBe("working");
    expect(statusOf({ kind: "built", attempt: 1, branch: "b" })).toBe("checking");
    expect(statusOf({ kind: "check", attempt: 1, passed: false })).toBe("working");
    expect(statusOf({ kind: "pr", url: "u", level: "quick", reasons: [] })).toBe("ready");
    expect(statusOf({ kind: "handover", reason: "r" })).toBe("handover");
  });
  test("adds the new status first, then removes the others, tolerating absent ones", async () => {
    const realFetch = globalThis.fetch;
    const calls: { method: string; name: string }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      calls.push({ method, name: JSON.parse(String(init?.body)).name });
      return Response.json(method === "reactions.remove" ? { ok: false, error: "no_reaction" } : { ok: true });
    }) as unknown as typeof fetch;
    try {
      await new Slack("xoxb").setStatus({ kind: "slack", channel: "C0DEMO", thread_ts: "1.2", user: "U1" }, "ready");
      expect(calls[0]).toEqual({ method: "reactions.add", name: "eyes" });
      expect(calls.slice(1).map((c) => c.method)).toEqual(Array(5).fill("reactions.remove"));
      expect(calls.some((c) => c.method === "reactions.remove" && c.name === "eyes")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("answers in a thread", () => {
  const ref = { kind: "slack" as const, channel: "C0DEMO", thread_ts: "1791631492.000100", user: "U1" };
  const prefix = "tasks/o/r/PROJ-9/abc";
  const pending = {
    task_token: "tok",
    execution_arn: "arn",
    prefix,
    resume: "build" as const,
    question: "Bytes or chars?",
    asked_by_user: "U1",
    jira_key: "PROJ-9",
    asked_at: "t",
  };
  const setup = (initial?: unknown, resume?: AnswerDeps["resume"]) => {
    const objects = new Map<string, unknown>(initial ? [[threadKey(ref), initial]] : []);
    const replies: string[] = [];
    const reported: { jira?: string; kind: string }[] = [];
    const resumed: unknown[] = [];
    const deps: AnswerDeps = {
      store: {
        json: async (key) => {
          if (!objects.has(key)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
          return objects.get(key);
        },
        putJson: async (key, value) => {
          objects.set(key, value);
          return key;
        },
        claim: async (key, value) => {
          if (objects.has(key)) return false;
          objects.set(key, value);
          return true;
        },
      },
      slack: { reply: async (_r, text) => void replies.push(text) },
      reporter: (jira) => ({ report: async (e) => void reported.push({ jira, kind: e.kind }) }),
      resume: async (token, output) => {
        resumed.push({ token, output });
        if (resume) await resume(token, output);
      },
    };
    return { deps, objects, replies, reported, resumed };
  };

  test("a mention in a thread is recognised as a reply", () => {
    const request = parseSlackRequest(mention("<@U0AGENT> chars", { thread_ts: "1791631000.000001" }));
    expect(request.kind === "mention" && request.in_thread).toBe(true);
    const top = parseSlackRequest(mention("<@U0AGENT> add x"));
    expect(top.kind === "mention" && top.in_thread).toBe(false);
  });
  test("the requester's answer is recorded, resumes the run once, and goes to Jira", async () => {
    const t = setup(pending);
    expect(await deliverAnswer(t.deps, { event_id: "Ev1", ref, text: "chars" })).toBe("resumed");
    expect(t.resumed).toEqual([{ token: "tok", output: { answered: true, resume: "build", answer: "chars" } }]);
    expect(t.objects.get(`${prefix}/answers.json`)).toEqual([
      { question: "Bytes or chars?", answer: "chars", by: "U1", resume: "build", at: expect.any(String) },
    ]);
    expect(t.reported).toEqual([{ jira: "PROJ-9", kind: "answered" }]);
    expect(await deliverAnswer(t.deps, { event_id: "Ev1", ref, text: "chars" })).toBe("duplicate");
    expect(await deliverAnswer(t.deps, { event_id: "Ev9", ref, text: "bytes" })).toBe("already_answered");
    expect(t.resumed).toHaveLength(1);
  });
  test("two answers delivered at once resume the run once and keep one answer", async () => {
    const t = setup(pending);
    const outcomes = await Promise.all([
      deliverAnswer(t.deps, { event_id: "Ev1", ref, text: "chars" }),
      deliverAnswer(t.deps, { event_id: "Ev2", ref, text: "bytes" }),
    ]);
    expect(outcomes.sort()).toEqual(["already_answered", "resumed"]);
    expect(t.resumed).toHaveLength(1);
    expect(t.objects.get(`${prefix}/answers.json`)).toHaveLength(1);
  });
  test("answers accumulate in answers.json", async () => {
    const t = setup(pending);
    t.objects.set(`${prefix}/answers.json`, [{ question: "q0", answer: "a0", by: "U1", resume: "plan", at: "t0" }]);
    await deliverAnswer(t.deps, { event_id: "Ev1", ref, text: "chars" });
    expect((t.objects.get(`${prefix}/answers.json`) as unknown[]).length).toBe(2);
  });
  test("only the requester may answer", async () => {
    const t = setup(pending);
    expect(await deliverAnswer(t.deps, { event_id: "Ev2", ref: { ...ref, user: "U2" }, text: "bytes" })).toBe("not_requester");
    expect(t.replies[0]).toBe("Only <@U1>, who asked for this task, can answer.");
    expect(t.resumed).toHaveLength(0);
  });
  test("without a waiting question nothing resumes", async () => {
    const t = setup();
    expect(await deliverAnswer(t.deps, { event_id: "Ev2", ref, text: "hello" })).toBe("nothing_pending");
    expect(t.replies[0]).toContain("Nothing in this thread is waiting");
  });
  test("an expired run gets an explanation and its answer is not kept", async () => {
    const t = setup(pending, async () => {
      throw Object.assign(new Error("gone"), { name: "TaskTimedOut" });
    });
    expect(await deliverAnswer(t.deps, { event_id: "Ev3", ref, text: "chars" })).toBe("expired");
    expect(t.replies[0]).toContain("no longer open");
    expect(t.objects.get(`${prefix}/answers.json`)).toEqual([]);
  });
  test("asking parks the token before posting the question", async () => {
    const realFetch = globalThis.fetch;
    const order: string[] = [];
    const objects = new Map<string, unknown>();
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      order.push(String(url).split("/").pop() ?? "");
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    try {
      const store = {
        json: async (key: string) => objects.get(key),
        putJson: async (key: string, value: unknown) => {
          order.push("park");
          objects.set(key, value);
          return key;
        },
        claim: async () => true,
      };
      const source = slackSource(new Slack("xoxb"), new Jira("https://x.atlassian.net", "bot@x", "t"), undefined, store);
      await source.askInThread({ repo: "o/r", source: "slack", ref, ask: "x", jira_project: "DEMO" }, undefined, {
        question: "Bytes or chars?",
        resume: "build",
        prefix,
        taskToken: "tok",
        executionArn: "arn",
      });
      expect(order[0]).toBe("park");
      expect(order[1]).toBe("chat.postMessage");
      expect(objects.get(threadKey(ref))).toMatchObject({
        task_token: "tok",
        resume: "build",
        prefix,
        asked_by_user: "U1",
        question: "Bytes or chars?",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("status in a thread", () => {
  const ref = { kind: "slack" as const, channel: "C0DEMO", thread_ts: "1791631492.000100", user: "U2" };
  const arn = "arn:aws:states:eu-west-1:1:execution:mork:slack-Ev1";
  const now = new Date("2026-10-10T12:10:00Z");
  const storeWith = (objects: Record<string, unknown>) => ({
    json: async (key: string) => {
      if (!(key in objects)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return objects[key];
    },
    putJson: async (key: string) => key,
    claim: async () => true,
  });
  const task = { [taskKey(ref)]: { execution_arn: arn, started_at: "2026-10-10T12:00:00Z" } };

  test("recognises a status request", () => {
    expect(asksForStatus("status")).toBe(true);
    expect(asksForStatus(" Progress?")).toBe(true);
    expect(asksForStatus("chars, not bytes")).toBe(false);
  });
  test("a running task shows its phase, attempt and how long", async () => {
    const run = {
      status: "RUNNING",
      startDate: new Date("2026-10-10T12:00:00Z"),
      current: { name: "Build", entered: new Date("2026-10-10T12:08:00Z"), attempt: 2 },
    };
    const text = await statusText({ store: storeWith(task), describe: async () => run }, ref, now);
    expect(text.split("\n")[0]).toBe("*Status:* implementing (attempt 2) for 2 min, started 10 min ago");
    expect(text).toContain("View the workflow run");
  });
  test("a parked question is what the task waits for", async () => {
    const pending = {
      task_token: "t",
      execution_arn: arn,
      prefix: "p",
      resume: "build",
      question: "Bytes or chars?",
      asked_by_user: "U1",
      asked_at: "t",
    };
    const store = storeWith({ ...task, [threadKey(ref)]: pending });
    const text = await statusText({ store, describe: async () => ({ status: "RUNNING" }) }, ref, now);
    expect(text.split("\n")[0]).toBe("*Status:* waiting for your answer to the question above");
  });
  test("a finished task shows its PR", async () => {
    const run = { status: "SUCCEEDED", output: JSON.stringify({ outcome: { level: "quick", url: "https://github.com/o/r/pull/27" } }) };
    const text = await statusText({ store: storeWith(task), describe: async () => run }, ref, now);
    expect(text.split("\n")[0]).toBe("*Status:* done, draft PR https://github.com/o/r/pull/27");
  });
  test("a thread without a task says so", async () => {
    expect(await statusText({ store: storeWith({}), describe: async () => ({ status: "RUNNING" }) }, ref, now)).toContain(
      "I have no task in this thread",
    );
  });
});

describe("question text", () => {
  test("a list of questions starts on its own line, one question stays inline", () => {
    expect(slackText({ kind: "question", text: "- Bytes?\n- Chars?" })).toStartWith("*Question:*\n- Bytes?");
    expect(slackText({ kind: "question", text: "Bytes or chars?" })).toStartWith("*Question:* Bytes or chars?");
  });
});
