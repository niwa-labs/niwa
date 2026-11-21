/**
 * The harness module: kinds, instances and the sides they have.
 * A kind is code and is resolved by name; an instance is an installation and has the id.
 */

import type { Harness, HarnessId, HarnessKind } from "./instance.ts";
import { harnessKind } from "./instance.ts";
import type { HarnessInsert } from "./insert.ts";
import type { SessionControl } from "./control.ts";
import type { SessionReading } from "./reading.ts";
import type { HarnessDetection } from "./discover.ts";
import type { KindOptions } from "./options.ts";
import { KindCapabilitiesSchema, excessOf, narrowSides, sidesOf } from "./declaration.ts";
import type { KindCapabilities } from "./declaration.ts";

/**
 * A harness kind: a name, the sides its code implements, and what it declares those sides can
 * serve. A side may be absent; its abilities are then all declared unsupported.
 */
export interface HarnessKindDefinition {
  readonly kind: HarnessKind;
  readonly reading?: SessionReading;
  readonly control?: SessionControl;
  readonly insert?: HarnessInsert;
  /** Every ability of every side, supported or not; an installation may claim no more. */
  readonly capabilities: KindCapabilities;
  /** How an installation of this kind is found on a machine. */
  readonly detect?: HarnessDetection;
  /** The options block a session of this kind takes at its start: its name and its schema. */
  readonly options?: KindOptions;
}

/** Which sides a kind has code for. */
function implementedOf(kind: { reading?: unknown; control?: unknown; insert?: unknown }) {
  return { reading: kind.reading !== undefined, control: kind.control !== undefined, insert: kind.insert !== undefined };
}

/**
 * A kind, once its declaration is whole and within its code: a declaration that leaves out an
 * ability, or supports one on a side the kind has no code for, does not register.
 */
export function defineHarnessKind(spec: {
  name: string;
  reading?: SessionReading;
  control?: SessionControl;
  insert?: HarnessInsert;
  capabilities: KindCapabilities;
  detect?: HarnessDetection;
  options?: KindOptions;
}): HarnessKindDefinition {
  const kind = harnessKind(spec.name);
  const capabilities = KindCapabilitiesSchema.parse(spec.capabilities);
  const beyond = excessOf(sidesOf(capabilities), capabilities, implementedOf(spec)).filter((line) => line.includes("has no"));
  if (beyond.length > 0) {
    throw new Error(`harness kind "${kind}" declares abilities of sides it has no code for: ${beyond.join(", ")}`);
  }
  return {
    kind,
    reading: spec.reading,
    control: spec.control,
    insert: spec.insert,
    capabilities,
    detect: spec.detect,
    options: spec.options,
  };
}

/**
 * Refuse an installation that claims what its kind cannot serve: a side without code, an ability
 * the kind does not support, a model choice, an effort level or a working mode it does not declare.
 */
export function admitInstance(instance: Harness, kind: HarnessKindDefinition): void {
  narrowSides(instance.id, kind.kind, kind.capabilities, instance.sides, implementedOf(kind));
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
  ADMITTED,
  CapabilityExceeded,
  KindCapabilitiesSchema,
  NO_CONTROL,
  NO_INSERT,
  NO_READING,
  SupportSchema,
  UNSUPPORTED,
  VERIFIED,
  excessOf,
  narrowSides,
  sidesOf,
} from "./declaration.ts";
export type { KindCapabilities, Support } from "./declaration.ts";

export {
  ClaudeOptions,
  KIND_OPTIONS,
  OptionBlocks,
  blocksOf,
} from "./options.ts";
export type { KindOptions, OptionsBlock } from "./options.ts";

export {
  ChecklistItemSchema,
  ChecklistSchema,
  ChecklistStateSchema,
  ToolCategorySchema,
  checklistProgress,
  shapeOf,
  targetOf,
} from "./tools.ts";
export type {
  Checklist,
  ChecklistItem,
  ChecklistProgress,
  ChecklistState,
  ToolCategory,
  ToolEntry,
  ToolShape,
  ToolTable,
} from "./tools.ts";

export {
  AssistantRecordSchema,
  ChecklistRecordSchema,
  CompactionRecordSchema,
  EMPTY,
  LocatorSchema,
  NOT_SCANNED,
  NativeSessionIdSchema,
  NestedRecordSchema,
  PermissionRecordSchema,
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
