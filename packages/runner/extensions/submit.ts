// Pi extension: the only way a station returns its structured result. The
// runner validates the file against the station schema after the run.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";

export default function submit(pi: any) {
  const out = process.env.MORK_OUTPUT;
  if (!out) throw new Error("MORK_OUTPUT is not set");
  pi.registerTool({
    name: "submit_result",
    label: "Submit result",
    description:
      "Submit the final structured result of this task as one JSON document that matches the schema in your instructions. Call it once, at the very end.",
    promptSnippet: "Submit the final JSON result of the task",
    promptGuidelines: ["Finish every task by calling submit_result with the JSON result; a task without submit_result counts as failed."],
    parameters: Type.Object({ json: Type.String({ description: "The result as a JSON document" }) }),
    async execute(_toolCallId: string, params: { json: string }) {
      try {
        JSON.parse(params.json);
      } catch (error) {
        throw new Error(`The json parameter is not valid JSON (${(error as Error).message}). Fix it and call submit_result again.`);
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, params.json);
      return { content: [{ type: "text", text: "Result recorded. You are done; stop now." }], details: {} };
    },
  });
}
