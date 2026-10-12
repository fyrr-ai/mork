// Pi extension, implementer only: `verify` runs the repository's own setup,
// test and checks commands and the diff policy on the working tree, so the
// agent can fix failures before it pushes. Hidden tests are not run here.
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { runVerify, type VerifySpec, verifyText } from "../src/verify.ts";

export default function verify(pi: any) {
  const specFile = process.env.MORK_VERIFY;
  if (!specFile) throw new Error("MORK_VERIFY is not set");
  const spec = JSON.parse(readFileSync(specFile, "utf8")) as VerifySpec;
  pi.registerTool({
    name: "verify",
    label: "Verify",
    description:
      "Run the repository's tests and checks (lint, typecheck…) and the platform's change policy on your working tree, exactly as the platform will. Returns what failed with the output tail.",
    promptSnippet: "Run the repository's tests, checks and change policy",
    promptGuidelines: [
      "Call verify after each meaningful change and before you push; fix every failure it reports and call it again until it passes.",
      "Only push and call submit_result once verify passes.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await runVerify(spec, process.cwd());
      return { content: [{ type: "text", text: verifyText(result) }], details: { passed: result.passed } };
    },
  });
}
