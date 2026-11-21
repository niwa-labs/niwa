/**
 * The harness module: kinds, instances and the sides they have.
 * A kind is code and is resolved by name; an instance is an installation and has the id.
 */

import type { Harness, HarnessId, HarnessKind } from "./instance.ts";
import { harnessKind } from "./instance.ts";
import type { HarnessSide } from "./capabilities.ts";
import type { HarnessInsert } from "./insert.ts";
import type { SessionControl } from "./control.ts";
import type { SessionReading } from "./reading.ts";
import type { HarnessDetection } from "./discover.ts";
import type { KindOptions } from "./options.ts";

/** A harness kind: a name and the sides its code implements. A side may be absent. */
export interface HarnessKindDefinition {
  readonly kind: HarnessKind;
  readonly reading?: SessionReading;
  readonly control?: SessionControl;
  readonly insert?: HarnessInsert;
  /** How an installation of this kind is found on a machine. */
  readonly detect?: HarnessDetection;
  /** The options block a session of this kind takes at its start: its name and its schema. */
  readonly options?: KindOptions;
}

export function defineHarnessKind(spec: {
  name: string;
  reading?: SessionReading;
  control?: SessionControl;
  insert?: HarnessInsert;
  detect?: HarnessDetection;
  options?: KindOptions;
}): HarnessKindDefinition {
  return {
    kind: harnessKind(spec.name),
    reading: spec.reading,
    control: spec.control,
    insert: spec.insert,
    detect: spec.detect,
    options: spec.options,
  };
}

/** The registry of kinds. A name is taken once. */
export class HarnessKindRegistry {
  private readonly kinds = new Map<HarnessKind, HarnessKindDefinition>();

  /** Returns the unregister. */
  register(definition: HarnessKindDefinition): () => void {
    if (this.kinds.has(definition.kind)) {
      throw new Error(`harness kind "${definition.kind}" is already registered`);
    }
    this.kinds.set(definition.kind, definition);
    return () => {
      if (this.kinds.get(definition.kind) === definition) this.kinds.delete(definition.kind);
    };
  }

  get(name: string): HarnessKindDefinition | undefined {
    return this.kinds.get(name as HarnessKind);
  }

  resolve(name: string): HarnessKindDefinition {
    const found = this.get(name);
    if (found === undefined) {
      throw new Error(
        `harness kind "${name}" is not registered (registered: ${this.names().join(", ") || "none"})`,
      );
    }
    return found;
  }

  names(): string[] {
    return [...this.kinds.keys()].sort();
  }
}

/** The registry of instances. An id is taken once. */
export class HarnessInstanceRegistry {
  private readonly instances = new Map<HarnessId, Harness>();

  /** Returns the unregister. */
  register(instance: Harness): () => void {
    if (this.instances.has(instance.id)) {
      throw new Error(`harness instance "${instance.id}" is already registered`);
    }
    this.instances.set(instance.id, instance);
    return () => {
      if (this.instances.get(instance.id) === instance) this.instances.delete(instance.id);
    };
  }

  get(id: string): Harness | undefined {
    return this.instances.get(id as HarnessId);
  }

  resolve(id: string): Harness {
    const found = this.get(id);
    if (found === undefined) {
      throw new Error(
        `harness instance "${id}" is not registered (registered: ${this.ids().join(", ") || "none"})`,
      );
    }
    return found;
  }

  ids(): string[] {
    return [...this.instances.keys()].sort();
  }

  ofKind(kind: string): Harness[] {
    return [...this.instances.values()]
      .filter((instance) => instance.kind === kind)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

/** The sides an instance claims but its kind does not implement; empty when consistent. */
export function sideMismatch(instance: Harness, kind: HarnessKindDefinition): HarnessSide[] {
  const sides: HarnessSide[] = ["reading", "control", "insert"];
  return sides.filter((side) => instance.sides[side] !== undefined && kind[side] === undefined);
}

export {
  HarnessBinarySchema,
  HarnessIdSchema,
  HarnessKindSchema,
  HarnessSchema,
  HarnessSidesSchema,
  MachineIdSchema,
  harnessId,
  harnessKind,
  machineId,
} from "./instance.ts";
export type {
  Harness,
  HarnessBinary,
  HarnessId,
  HarnessKind,
  HarnessSides,
  MachineId,
} from "./instance.ts";

export {
  ControlCapabilitiesSchema,
  InsertCapabilitiesSchema,
  ReadingCapabilitiesSchema,
  SideCapabilitiesSchema,
  Unavailable,
  Unsupported,
  requireAbility,
  DEFAULT_SESSION_MODE,
  SessionModeSchema,
  modeOf,
  requireLaunch,
  requireOwnBlocks,
  supports,
} from "./capabilities.ts";
export type {
  ControlCapabilities,
  LaunchCapabilities,
  HarnessSide,
  SessionMode,
  InsertCapabilities,
  ReadingCapabilities,
  SideAbilities,
  SideCapabilities,
} from "./capabilities.ts";

export {
  ClaudeOptions,
  KIND_OPTIONS,
  OptionBlocks,
  blocksOf,
} from "./options.ts";
export type { KindOptions, OptionsBlock } from "./options.ts";

export {
  AssistantRecordSchema,
  CompactionRecordSchema,
  EMPTY,
  LocatorSchema,
  NOT_SCANNED,
  NativeSessionIdSchema,
  NestedRecordSchema,
  SessionIdSchema,
  SessionRecordSchema,
  ThinkingRecordSchema,
  ToolCallRecordSchema,
  ToolResultRecordSchema,
  UnknownRecordSchema,
  UserRecordSchema,
  TITLE_LENGTH,
  TitleCache,
  failedCoverage,
  firstMessageTitle,
  sameSession,
  sessionId,
  titleFromText,
  unavailableCoverage,
} from "./reading.ts";
export type {
  Coverage,
  Locator,
  NativeSessionId,
  SessionFilter,
  SessionId,
  SessionInfo,
  SessionReading,
  SessionRecord,
  SessionRecordKind,
  TitleKey,
} from "./reading.ts";

export {
  DeliveryReceiptSchema,
  LifeEventSchema,
  ModelNameSchema,
  NO_VISIBLE_ACTIONS,
  PermissionMarkSchema,
  PromptSchema,
  PromptSectionSchema,
  PromptTierSchema,
  DEFAULT_TURN_TIMEOUT_MS,
  modelName,
  ProtocolNameSchema,
  VariantNameSchema,
  promptFromText,
  rawJson,
  unknownVariantSigns,
} from "./control.ts";
export { BundledProgramSchema, findBundled, manifestVersion } from "./bundled.ts";
export type { BundledProgram } from "./bundled.ts";
export type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  LifeEvent,
  McpServerSpec,
  ModelName,
  ZcodeMcpOptions,
  PermissionMark,
  Prompt,
  PromptSection,
  PromptTier,
  ProtocolName,
  ResumeOptions,
  SendOptions,
  SessionControl,
  SessionState,
  StartOptions,
  StartedSession,
  ToolAllowance,
  VariantName,
  VisibleActions,
} from "./control.ts";

export type { ReverseHandler, ReverseRequest } from "./reverse.ts";

export {
  CompactedEventSchema,
  INSERT_REPORT_ACTION,
  InsertEventSchema,
  NIWA_CLI_ENV,
  NIWA_SESSION_ENV,
  NestedSpawnedEventSchema,
  OpenedByHandEventSchema,
  PermissionAnswerSchema,
  PermissionAskedEventSchema,
  eventSession,
} from "./insert.ts";
export type {
  CompactedEvent,
  HarnessInsert,
  InsertEvent,
  InsertEventKind,
  InsertInstallOptions,
  NestedSpawnedEvent,
  OpenedByHandEvent,
  PermissionAnswer,
  PermissionAskedEvent,
} from "./insert.ts";

export { SCENARIOS } from "./conformance/fixtures.ts";
export type { FixtureResult, FixtureWriter, Scenario } from "./conformance/fixtures.ts";

export { readingConformance } from "./conformance/reading.ts";
export type {
  ConformanceReport,
  ConformanceResult,
  ConformanceSides,
} from "./conformance/reading.ts";

export { controlConformance } from "./conformance/control.ts";
export type { ControlConformanceSides } from "./conformance/control.ts";

export { insertConformance } from "./conformance/insert.ts";
export type { InsertConformanceSides } from "./conformance/insert.ts";

export {
  HarnessDetectionSchema,
  HarnessMissingSchema,
  HarnessProposalSchema,
  binaryEnvVarOf,
  discover,
} from "./discover.ts";
export type {
  DiscoverEnv,
  HarnessDetection,
  HarnessDiscoveryResult,
  HarnessMissing,
  HarnessProposal,
} from "./discover.ts";

export { reportThroughCli } from "./insert-report.ts";
export type { InsertReportTarget } from "./insert-report.ts";

export { SHARED_AGENTS_SKILLS } from "./skills.ts";
export type { KindSkills, SkillRoots } from "./skills.ts";
