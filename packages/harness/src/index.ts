/**
 * The harness module: kinds, instances and the sides they have.
 * A kind is code and is resolved by name; an instance is an installation and has the id.
 */

import { z } from "zod";

import type { Harness, HarnessId, HarnessKind, HarnessBinary } from "./instance.ts";
import { harnessId, harnessKind, machineId } from "./instance.ts";
import type { HarnessInsert } from "./insert.ts";
import type { SessionControl } from "./control.ts";
import type { SessionReading } from "./reading.ts";
import type { HarnessDetection } from "./discover.ts";
import type { KindOptions } from "./options.ts";
import type { HarnessSide, SideCapabilities } from "./capabilities.ts";
import { CapabilityExceeded, KindCapabilitiesSchema, excessOf, narrowSides, sidesOf } from "./declaration.ts";
import { LoopbackListenSchema } from "@niwa-labs/sandbox";
import type { BoxProfile, LoopbackListen, ProfilePaths } from "@niwa-labs/sandbox";
import type { KindCapabilities } from "./declaration.ts";

/**
 * What every installation of a kind is given, whatever its kind. A kind's own options extend it with
 * what only that kind takes (the binary it runs, a profile, the timeouts of its control side).
 */
export interface InstanceOptions {
  /** The id the owner gives the installation (`claude-haiku`): half of the identity of each of its sessions. */
  readonly id: string;
  /** The machine the installation is on. Default: `local`. */
  readonly machine?: string;
  /** The directory of its settings and sessions; where the kind itself looks when absent. */
  readonly home?: string;
  /**
   * The model each session of the installation runs, unless its start names another. Absent, the
   * harness's own default stands. A kind that cannot choose a model refuses one.
   */
  readonly model?: string;
  /** The program of the installation, as it was found on the machine. */
  readonly binary?: HarnessBinary;
  /**
   * Hosts its model is reached at besides the ones its kind knows: a provider of the owner's own.
   * Use `boxProfile.net` to replace the default list.
   */
  readonly net?: readonly string[];
  /** The installation's overrides for the network fields of its kind's box profile. */
  readonly boxProfile?: {
    /** The outbound host list, including any explicit `*.example.com` patterns. Omit to inherit. */
    readonly net?: readonly string[];
    /** Replace the local listener. Omit to inherit or pass null to remove it. */
    readonly listen?: LoopbackListen | null;
  };
  /**
   * What the installation claims: what was found on the machine, which may narrow what the kind
   * declares and never widen it. Default: the kind's own sides.
   */
  readonly sides?: SideCapabilities;
}

/** The sides of one installation, as a kind's code makes them for it. */
export interface InstanceSides {
  readonly reading?: SessionReading;
  readonly control?: SessionControl;
  readonly insert?: HarnessInsert;
}

/**
 * One installation and the code that serves it: the instance, the sides bound to its id and its
 * home, and the options block a session of it takes. `kind.bind(...)` makes one; a check may make
 * one by hand.
 */
export interface HarnessBinding extends InstanceSides {
  readonly instance: Harness;
  /** The options block a session of this installation's kind takes at its start. */
  readonly options?: KindOptions;
  /**
   * The paths the installation needs inside a box: its program, its sign-in, its sessions, its
   * configuration and caches. Its sessions take it; every other box finds them closed. A binding
   * made by hand without one needs nothing of its own.
   */
  readonly profile?: BoxProfile;
}

/**
 * What a kind says of the box its sessions need. `verified`: a session of the kind ran in a box
 * closed to reading with nothing but this profile; `admitted`: declared, not yet proven.
 */
export interface KindProfile<Options extends InstanceOptions = InstanceOptions> {
  readonly status: "verified" | "admitted";
  /** The profile of one installation, from its options with the id and the home settled. */
  of(options: Options & { readonly id: HarnessId; readonly home: string }): BoxProfile;
}

/**
 * A harness kind: a name, what it declares its sides can serve, and the code that binds it to an
 * installation. The kind is not bound to any installation: `bind` gives each one its own sides,
 * read from and started in its own home, under its own id, with its own options.
 */
export interface HarnessKindDefinition<Options extends InstanceOptions = InstanceOptions> {
  readonly kind: HarnessKind;
  /** Every ability of every side, supported or not; an installation may claim no more. */
  readonly capabilities: KindCapabilities;
  /** The sides the kind has code for: the ones `bind` gives every installation. */
  readonly implements: readonly HarnessSide[];
  /** The sides an installation has when nothing narrows them. */
  readonly sides: SideCapabilities;
  /** How an installation of this kind is found on a machine. */
  readonly detect?: HarnessDetection;
  /** The options block a session of this kind takes at its start: its name and its schema. */
  readonly options?: KindOptions;
  /** What its installations need inside a box, and whether that is proven: a kind without one does not register. */
  readonly profile: KindProfile<Options>;
  /**
   * One installation of the kind, with its sides. Refused when it claims what the kind cannot serve:
   * an ability the kind does not support, or a model on a kind that cannot choose one.
   */
  bind(options: Options): HarnessBinding;
}

/** What `defineHarnessKind` takes. */
export interface HarnessKindSpec<Options extends InstanceOptions> {
  readonly name: string;
  readonly capabilities: KindCapabilities;
  /** The sides the kind has code for: `bind` must give each installation exactly these. */
  readonly implements: readonly HarnessSide[];
  /** The sides an installation has when nothing narrows them. Default: every ability the kind supports. */
  readonly sides?: SideCapabilities;
  readonly detect?: HarnessDetection;
  readonly options?: KindOptions;
  /** The home of an installation that names none: where the harness itself looks. */
  readonly home: (options: Options) => string;
  /** The sides of one installation, from its options with the id and the home settled. */
  readonly bind: (options: Options & { readonly id: HarnessId; readonly home: string }) => InstanceSides;
  /** The paths an installation needs inside a box. */
  readonly profile: KindProfile<Options>;
}

const HostnameSchema = z.hostname();
const BoxProfileHostSchema = z.union([
  HostnameSchema,
  z.ipv6(),
  z.string().refine((host) => host.startsWith("*.") && HostnameSchema.safeParse(host.slice(2)).success),
], { error: "use a hostname, IP address, or subdomain pattern such as *.example.com" });

const BoxProfileOverrideSchema = z.strictObject({
  net: z.array(BoxProfileHostSchema).optional(),
  listen: LoopbackListenSchema.nullable().optional(),
});

/** Apply only the network fields the owner named, preserving the kind's filesystem paths. */
function withProfileOverrides(
  profile: BoxProfile,
  extraHosts: readonly string[] | undefined,
  override: z.output<typeof BoxProfileOverrideSchema> | undefined,
): BoxProfile {
  if (override?.net === undefined && override?.listen === undefined && !extraHosts?.length) return profile;
  const apply = (paths: ProfilePaths): ProfilePaths => {
    const { listen: defaultListen, ...rest } = paths;
    const listen = override?.listen === undefined ? defaultListen : override.listen;
    const net = override?.net ?? (extraHosts?.length ? [...(paths.net ?? []), ...extraHosts] : paths.net);
    return {
      ...rest,
      ...(net === undefined ? {} : { net }),
      ...(listen == null ? {} : { listen }),
    };
  };
  return typeof profile === "function" ? (context) => apply(profile(context)) : apply(profile);
}

/** Which sides a kind has code for, as `narrowSides` takes them. */
function implementedOf(sides: readonly HarnessSide[]) {
  return { reading: sides.includes("reading"), control: sides.includes("control"), insert: sides.includes("insert") };
}

/** The machine an installation is on when it names none. */
const LOCAL_MACHINE = "local";

/**
 * A kind, once its declaration is whole and within its code: a declaration that leaves out an
 * ability, supports one on a side the kind has no code for, or gives installations sides beyond
 * itself, does not register.
 */
export function defineHarnessKind<Options extends InstanceOptions>(spec: HarnessKindSpec<Options>): HarnessKindDefinition<Options> {
  const kind = harnessKind(spec.name);
  requireProfile(kind, spec.profile);
  const capabilities = KindCapabilitiesSchema.parse(spec.capabilities);
  const implemented = implementedOf(spec.implements);
  const beyond = excessOf(sidesOf(capabilities), capabilities, implemented).filter((line) => line.includes("has no"));
  if (beyond.length > 0) {
    throw new Error(`harness kind "${kind}" declares abilities of sides it has no code for: ${beyond.join(", ")}`);
  }
  const sides = spec.sides ?? sidesOf(capabilities);
  const wider = excessOf(sides, capabilities, implemented);
  if (wider.length > 0) throw new Error(`harness kind "${kind}" gives its installations what it does not declare: ${wider.join(", ")}`);
  return {
    kind,
    capabilities,
    implements: [...spec.implements],
    sides,
    ...(spec.detect === undefined ? {} : { detect: spec.detect }),
    ...(spec.options === undefined ? {} : { options: spec.options }),
    profile: spec.profile,
    bind(options: Options): HarnessBinding {
      const id = harnessId(options.id);
      const claimed = narrowSides(id, kind, capabilities, options.sides ?? sides, implemented);
      if (options.model !== undefined && !capabilities.control.launch.model.supported) {
        throw new CapabilityExceeded(id, kind, [`control.launch.model (asked for "${options.model}")`]);
      }
      const home = options.home ?? spec.home(options);
      const profileOverride = BoxProfileOverrideSchema.optional().parse(options.boxProfile);
      const bound = spec.bind({ ...options, id, home });
      const profile = withProfileOverrides(spec.profile.of({ ...options, id, home }), options.net, profileOverride);
      const missing = spec.implements.filter((side) => bound[side] === undefined);
      if (missing.length > 0) throw new Error(`harness kind "${kind}" bound "${id}" without its ${missing.join(", ")} side`);
      const instance: Harness = {
        id,
        kind,
        machine: machineId(options.machine ?? LOCAL_MACHINE),
        ...(options.binary === undefined ? {} : { binary: options.binary }),
        home,
        ...(options.model === undefined ? {} : { model: options.model }),
        sides: claimed,
      };
      return {
        instance,
        ...(bound.reading === undefined ? {} : { reading: bound.reading }),
        ...(bound.control === undefined ? {} : { control: bound.control }),
        ...(bound.insert === undefined ? {} : { insert: bound.insert }),
        ...(spec.options === undefined ? {} : { options: spec.options }),
        profile,
      };
    },
  };
}

/** A kind must say what its sessions need inside a box: one that does not, does not register. */
function requireProfile(kind: HarnessKind, profile: { readonly status?: unknown; readonly of?: unknown } | undefined): void {
  if (profile === undefined || typeof profile.of !== "function" || (profile.status !== "verified" && profile.status !== "admitted")) {
    throw new Error(`harness kind "${kind}" declares no profile: what its sessions need inside a box must be said`);
  }
}

/**
 * Refuse an installation that claims what its kind cannot serve: a side without code, an ability
 * the kind does not support, a model choice, an effort level or a working mode it does not declare.
 */
export function admitInstance(instance: Harness, kind: Pick<HarnessKindDefinition, "kind" | "capabilities" | "implements">): void {
  narrowSides(instance.id, kind.kind, kind.capabilities, instance.sides, implementedOf(kind.implements));
  if (instance.model !== undefined && !kind.capabilities.control.launch.model.supported) {
    throw new CapabilityExceeded(instance.id, kind.kind, [`control.launch.model (asked for "${instance.model}")`]);
  }
}

/** The registry of kinds. A name is taken once. */
export class HarnessKindRegistry {
  private readonly kinds = new Map<HarnessKind, HarnessKindDefinition>();

  /** Returns the unregister. */
  register(definition: HarnessKindDefinition): () => void {
    requireProfile(definition.kind, definition.profile);
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

/**
 * The registry of installations, each with the code that serves it. An id is taken once: two
 * installations of one kind are two entries, each with its own sides.
 *
 * Given the registry of kinds, it also refuses an installation whose kind is not registered, or
 * that claims what its kind cannot serve (`admitInstance`), before anything can ask it for that.
 */
export class HarnessInstanceRegistry {
  private readonly entries = new Map<HarnessId, HarnessBinding>();

  constructor(private readonly kinds?: HarnessKindRegistry) {}

  /** Returns the unregister. An instance without its sides is taken too: it is known, and serves nothing. */
  register(entry: HarnessBinding | Harness): () => void {
    const binding: HarnessBinding = "instance" in entry ? entry : { instance: entry };
    const { instance } = binding;
    if (this.entries.has(instance.id)) {
      throw new Error(`harness instance "${instance.id}" is already registered`);
    }
    if (this.kinds !== undefined) admitInstance(instance, this.kinds.resolve(instance.kind));
    this.entries.set(instance.id, binding);
    return () => {
      if (this.entries.get(instance.id) === binding) this.entries.delete(instance.id);
    };
  }

  get(id: string): Harness | undefined {
    return this.entries.get(id as HarnessId)?.instance;
  }

  resolve(id: string): Harness {
    return this.bindingOf(id).instance;
  }

  /** The installation and its sides. */
  bindingOf(id: string): HarnessBinding {
    const found = this.entries.get(id as HarnessId);
    if (found === undefined) {
      throw new Error(
        `harness instance "${id}" is not registered (registered: ${this.ids().join(", ") || "none"})`,
      );
    }
    return found;
  }

  /** Every installation with its sides, by id. */
  bindings(): HarnessBinding[] {
    return this.ids().map((id) => this.bindingOf(id));
  }

  ids(): string[] {
    return [...this.entries.keys()].sort();
  }

  ofKind(kind: string): Harness[] {
    return [...this.entries.values()]
      .map((binding) => binding.instance)
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
  requireTools,
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

export { NoOptions, OptionBlocksSchema, OptionsBlockNameSchema, blocksOf, kindOptions, withBlocks } from "./options.ts";
export type { KindOptions, OptionBlocks, OptionsBlock, OptionsBlockValue } from "./options.ts";

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
  ImageMarkSchema,
  InsertedRangeSchema,
  InsertionOriginSchema,
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
  insertedRanges,
  sameSession,
  sessionId,
  takeImages,
  titleFromText,
  unavailableCoverage,
} from "./reading.ts";
export type {
  Coverage,
  ImageMark,
  InsertedRange,
  InsertionOrigin,
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
  TurnOutcomeSchema,
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
  ToolsModeSchema,
  describeToolsMode,
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
  TurnOutcome,
  McpServerSpec,
  ModelName,
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
  ToolsMode,
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
  SessionEndedEventSchema,
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
  SessionEndedEvent,
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
export { profileConformance } from "./conformance/profile.ts";
export type { ProfileConformanceOptions, ProfileConformanceResult } from "./conformance/profile.ts";
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
export { InputNotSent, InputOutcomeSchema, InputPossiblySent, inputFailure, outcomeOf } from "./delivery.ts";
export type { Dispatch, InputOutcome } from "./delivery.ts";
