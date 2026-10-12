// Public entry of the decision layer; see core.ts for the model.
import { type Decider, DecisionPanel } from "./core.ts";
import { JevDecider } from "./jev.ts";
import { OpenAiDecider } from "./openai.ts";

export * from "./core.ts";
export { JevDecider } from "./jev.ts";
export { OpenAiDecider } from "./openai.ts";
export * from "./policies.ts";

/**
 * MORK_DECISION_PRIMARY: `jev` or `openai`; defaults to the first configured.
 * Providers are configured by their keys: JEV_API, OPENAI_API_KEY.
 */
export function panelFromEnv(env: NodeJS.ProcessEnv): DecisionPanel {
  const providers: Decider[] = [];
  const jevKey = env.JEV_API ?? env.TYPESAFE_API_KEY;
  if (jevKey) providers.push(new JevDecider(jevKey, env.TYPESAFE_BASE_URL, env.TYPESAFE_MODEL));
  if (env.OPENAI_API_KEY) providers.push(new OpenAiDecider(env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.OPENAI_DECISIONS_MODEL));
  return new DecisionPanel(providers, env.MORK_DECISION_PRIMARY || undefined);
}
