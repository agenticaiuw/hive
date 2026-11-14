import type { RuntimeEnv } from "./env";

/**
 * The agents the website can hand an instruction to. Every instruction goes to Hive's orchestrator
 * in the cloud (cloud/vm-agent/orchestrator.mjs on the owner's VM) through the task board's queue:
 * it plans the instruction into tasks, picks a model for each and starts them.
 */
export const ORCHESTRATOR = { id: "hive-cloud", name: "Hive", where: "the cloud" };

/** Whether the task board (and so the orchestrator's queue) is connected on this host. */
export function boardConnected(env: RuntimeEnv): boolean {
  return Boolean(env.TASKS_TOKEN && (env.TASKS || env.TASKS_URL));
}

export const NOT_CONNECTED = "The task board isn't connected on this server (TASKS_TOKEN and the TASKS binding).";
