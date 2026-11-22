/**
 * The sandbox module: `Sandbox { name, class, available, manifest,
 * launch }` over the `BoxSpec`. The process class is built (srt, nono); microVMs are not.
 *
 * The `spawnAgent` funnel (`launch.ts`) is here too: the one place an agent process is born, boxed
 * or not.
 */

export { BoxPathSchema, BoxSpecSchema, EnvNameSchema, LoopbackListenSchema, NetHostSchema, UnixSocketBindSchema, boxSpec } from "./spec.ts";
export type { BoxPath, BoxSpec, BoxSpecInput, EnvName, ListenNeed, LoopbackListen, NetHost, UnixSocketBind } from "./spec.ts";
export { BoxRefused, SandboxUnavailable, requireSandbox } from "./sandbox.ts";
export type { BoxPolicy, BoxRefusal, LaunchedBox, Sandbox, SandboxClass, SandboxManifest, SandboxName } from "./sandbox.ts";
export {
  ALWAYS_CLOSED,
  AccessItemSchema,
  BoxAccessSchema,
  BoxManifestSchema,
  BoxPolicySchema,
  admit,
  boxManifest,
  itemOf,
  itemText,
  placeTarget,
  repositoryOf,
  sandbox,
  planSpec,
} from "./access.ts";
export type {
  AccessItem,
  AccessItemInput,
  BoxAccess,
  BoxAccessInput,
  BoxManifest,
  BoxPlan,
  BoxProfiles,
  Origin,
  PathNeed,
  PlanInput,
  ProfileName,
  SandboxHost,
  SandboxOptions,
  Skipped,
} from "./access.ts";
export { programPaths, realPlace, resolveProfile } from "./profile.ts";
export type { BoxProfile, ProfileContext, ProfilePaths, ResolvedProfile } from "./profile.ts";
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
  sandboxOf,
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
  SpawnEvent,
} from "./launch.ts";
