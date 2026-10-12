// Step Functions callback for a station started with ecs:runTask.waitForTaskToken.
// The task token and the brief arrive as container overrides; both stay in
// this (root) process.
import { SendTaskFailureCommand, SendTaskHeartbeatCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { Brief, HANDOVER_ERROR, INTERRUPTED_ERROR, Phase, type RunResult } from "@mork/contracts";

const HEARTBEAT_MS = 60_000;
const sfn = new SFNClient({});

export function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function briefFromEnv(env: NodeJS.ProcessEnv): { phase: Phase; brief: Brief; token: string } {
  return {
    phase: Phase.parse(env.MORK_PHASE),
    brief: Brief.parse(JSON.parse(requiredEnv(env, "MORK_BRIEF"))),
    token: requiredEnv(env, "MORK_TASK_TOKEN"),
  };
}

/**
 * Keeps the Step Functions task alive while `work` runs, then reports its
 * result. A thrown error fails the state: `Handover` carries the reason for
 * the person, anything else is reported as an unexpected StationError.
 */
export async function reportTo(token: string, work: () => Promise<RunResult>): Promise<RunResult> {
  const timer = setInterval(() => {
    void sfn.send(new SendTaskHeartbeatCommand({ taskToken: token })).catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    const result = await work();
    await sfn.send(new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify(result) }));
    return result;
  } catch (error) {
    const handover = error instanceof Error && error.name === HANDOVER_ERROR;
    const cause = handover ? error.message : String(error);
    await sfn.send(
      new SendTaskFailureCommand({ taskToken: token, error: handover ? HANDOVER_ERROR : "StationError", cause: cause.slice(0, 32_000) }),
    );
    return { ok: false, error: cause.slice(0, 4000) };
  } finally {
    clearInterval(timer);
  }
}

/** Fails the phase as interrupted so Step Functions retries it; a token already answered or closed is fine. */
export async function reportInterrupted(token: string, phase: Phase): Promise<void> {
  await sfn
    .send(new SendTaskFailureCommand({ taskToken: token, error: INTERRUPTED_ERROR, cause: `${phase} container stopped before it finished` }))
    .catch(() => undefined);
}
