/**
 * The sandbox module: `Sandbox { name, class, available, manifest,
 * launch }` over the `BoxSpec`. The process class is built (srt, nono); microVMs are not.
 *
 * The `spawnAgent` funnel (`launch.ts`) is here too: the one place an agent process is born, boxed
 * or not.
 */

export { BoxPathSchema, BoxSpecSchema, EnvNameSchema, NetHostSchema, boxSpec } from "./spec.ts";
export type { BoxPath, BoxSpec, BoxSpecInput, EnvName, NetHost } from "./spec.ts";
export { SandboxUnavailable, SandboxUnsupported, requireSandbox } from "./sandbox.ts";
export type { LaunchedBox, Sandbox, SandboxClass, SandboxGuarantees, SandboxManifest, SandboxName } from "./sandbox.ts";
export { srt } from "./srt.ts";
export type { SrtManifest, SrtOptions, SrtSettings } from "./srt.ts";
export { nono } from "./nono.ts";
export type { NonoManifest, NonoOptions, NonoProfile } from "./nono.ts";
export {
  LIVE_PROCESS_REFUSAL,
  homePath,
  onBoxManifest,
  onSpawn,
  requireBox,
  spawnAgent,
  spawnAgentNow,
  useSandbox,
} from "./launch.ts";
export type {
  AgentLaunch,
  AgentProcess,
  BoxRecord,
  BoxRequest,
  BoxSandboxName,
  HarnessNeeds,
  SpawnEvent,
} from "./launch.ts";
