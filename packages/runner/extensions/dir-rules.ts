// Pi extension loaded into every LLM station: directory rules (AGENTS.md
// below the root, which Pi loads itself) reach the agent before it changes a
// file there. The first edit or write under a directory with unseen rules is
// blocked with the rules as the reason, so the agent retries knowing them;
// reads get the rules appended to the result.
import { rulesFor } from "../src/dir-rules.ts";

export default function dirRules(pi: any) {
  const baseSha = process.env.MORK_BASE_SHA;
  if (!baseSha) throw new Error("MORK_BASE_SHA is not set");
  const shown = new Set<string>();
  pi.on("tool_call", async (event: any) => {
    const path = event.input?.path;
    if ((event.toolName !== "edit" && event.toolName !== "write") || typeof path !== "string") return undefined;
    const rules = rulesFor(process.cwd(), baseSha, path, shown);
    if (!rules) return undefined;
    return { block: true, reason: `${rules.trim()}\n\nApply these rules, then repeat the same ${event.toolName} call.` };
  });
  pi.on("tool_result", async (event: any) => {
    const path = event.input?.path;
    if (event.toolName !== "read" || typeof path !== "string" || event.isError) return undefined;
    const rules = rulesFor(process.cwd(), baseSha, path, shown);
    if (!rules) return undefined;
    return { content: [...(event.content ?? []), { type: "text", text: rules }] };
  });
}
