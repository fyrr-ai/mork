import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { IssueDoc } from "@mork/contracts";
import { type LocalResult, runLocalWorkflow } from "./local.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    definition: { type: "string" },
    trusted: { type: "boolean" },
    repo: { type: "string" },
    issue: { type: "string" },
    output: { type: "string" },
    resume: { type: "string" },
    base: { type: "string" },
    reference: { type: "string", multiple: true },
    model: { type: "string" },
    "llm-url": { type: "string" },
    pi: { type: "string", default: process.env.PI_BIN ?? "pi" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(
    "Usage: mise run workflow:local -- --trusted --repo PATH --issue issue.json --output NEW_TASK_DIR --model MODEL --llm-url URL [--base COMMIT] [--pi BIN] [--definition development.json]",
  );
  console.log(
    "Resume: mise run workflow:local -- --trusted --resume TASK_DIR --model MODEL --llm-url URL [--pi BIN] [--definition development.json]",
  );
  console.log("issue.json is {ref,title,body}. Set MORK_LOCAL_API_KEY for authenticated model endpoints.");
  console.log(
    "References: repeat --reference NAME=/absolute/local/repo for each configured reference. Uses its pinned SHA; mappings persist on resume.",
  );
  console.log("Runs real Plan/Build/Check and pushes to a task-owned bare Git remote. No AWS, GitHub PR or merge.");
  console.log("Trusted Linux mode: tools run as your user and can read the model key in private Pi config. Use only trusted repositories.");
  process.exit(0);
}
if (!values.trusted) throw new Error("--trusted is required because local tools run with your identity and access to the model key");
if (!values.model || !values["llm-url"]) throw new Error("--model and --llm-url are required");
const references: Record<string, string> = Object.create(null);
for (const mapping of values.reference ?? []) {
  const equals = mapping.indexOf("=");
  const name = mapping.slice(0, equals);
  if (equals < 1 || !/^[A-Za-z0-9_-]+$/.test(name) || !mapping.slice(equals + 1)) throw new Error("--reference requires NAME=/absolute/local/repo");
  if (Object.hasOwn(references, name)) throw new Error(`Duplicate local reference: ${name}`);
  references[name] = mapping.slice(equals + 1);
}
const connection = {
  references: values.reference ? references : undefined,
  model: values.model,
  llmBaseUrl: values["llm-url"],
  apiKey: process.env.MORK_LOCAL_API_KEY ?? "local-no-auth",
  piBin: values.pi ?? "pi",
};
let result: LocalResult;
if (values.resume) {
  if (values.repo || values.issue || values.output || values.base || values.definition)
    throw new Error("--resume cannot be combined with --repo, --issue, --output, --base or --definition");
  result = await runLocalWorkflow({ ...connection, resume: true, directory: values.resume });
} else {
  if (!values.repo || !values.issue || !values.output) throw new Error("--repo, --issue and --output are required for a new local workflow");
  result = await runLocalWorkflow({
    ...connection,
    directory: values.output,
    definition: values.definition ? JSON.parse(readFileSync(values.definition, "utf8")) : undefined,
    source: values.repo,
    issue: IssueDoc.parse(JSON.parse(readFileSync(values.issue, "utf8"))),
    base: values.base,
  });
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
