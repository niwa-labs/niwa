/**
 * The records entry of the agent module: what another plugin may import from it. The definition of an
 * agent, the records the module writes, the typed references of its actions and the hooks a later plugin
 * reads (the sections of a briefing, the digests of attached sessions); no factory and nothing that runs.
 *
 * An agent is a lasting actor with a name, called at `agent:<name>`. Its definition says what it runs on,
 * what it is told and what it may reach; which session it is on, what waits in its inbox and which native
 * sessions are attached to it are facts of the journal, folded when they are needed.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { Address, actionRef, record, stableJson } from "@niwa-labs/core";
import { ReplyRoute } from "@niwa-labs/messages/records";
import { offerKey, trigger } from "@niwa-labs/plugin";
import type { OfferKey, Trigger } from "@niwa-labs/plugin";
import { DeliveryReceiptSchema } from "@niwa-labs/sessions/records";

/** The name of an agent: lowercase words joined by `-`, `_` or `.`; its address is `agent:<name>`. */
export const AgentName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "an agent's name is lowercase letters, digits, '.', '_' or '-', at most 64");
export type AgentName = z.output<typeof AgentName>;

/** The tools an agent's sessions may use: the harness's own, only niwa's, or exactly these of the harness's own. */
export const AgentTools = z.union([z.literal("all"), z.literal("niwa-only"), z.object({ allow: z.array(z.string().min(1)) }).strict()]);
export type AgentTools = z.output<typeof AgentTools>;

/** The project an agent is bound to: the directory its sessions work in, and the direction it leads, when it leads one. */
export const AgentProject = z.object({ cwd: z.string().min(1), direction: z.string().min(1).optional() }).strict();
export type AgentProject = z.output<typeof AgentProject>;

/**
 * What an agent is: what it runs on (a harness installation, or a role the composition maps to one), what
 * its sessions are told (its prompt, and its character apart from it), its hands (the niwa actions its
 * sessions see: what is offered to the model; each call is still held to the session's grant), the tools
 * of the harness it may use, and the project it is bound to.
 */
export const AgentDefinition = z
  .object({
    name: AgentName,
    harness: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    prompt: z.string().min(1),
    character: z.string().min(1).optional(),
    hands: z.array(z.string().min(1)).default([]),
    tools: AgentTools.default("all"),
    project: AgentProject.optional(),
  })
  .strict()
  .refine((definition) => (definition.harness === undefined) !== (definition.role === undefined), "an agent runs on a harness or on a role, exactly one of them");
export type AgentDefinition = z.output<typeof AgentDefinition>;
export type AgentDefinitionInput = z.input<typeof AgentDefinition>;

/** The parts of a definition that are versioned apart: a session started from it says the version of each. */
export const DEFINITION_PARTS = ["prompt", "character", "hands", "tools", "project"] as const;
export type DefinitionPart = (typeof DEFINITION_PARTS)[number];

/** The version of a part: the first twelve hex digits of the SHA-256 of its value. */
export const PartVersion = z.string().regex(/^[0-9a-f]{12}$/);

/** The versions of the parts a definition has. */
export const PartVersions = z.partialRecord(z.enum(DEFINITION_PARTS), PartVersion);
export type PartVersions = z.output<typeof PartVersions>;

/** The versions of the parts of a definition; a part the definition does not have has none. */
export function partVersions(definition: AgentDefinition): PartVersions {
  const versions: PartVersions = {};
  for (const part of DEFINITION_PARTS) {
    const value = definition[part];
    if (value !== undefined) versions[part] = createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 12);
  }
  return versions;
}

/** A session as the sessions module names it: `<harness> <native>`. */
export const SessionRefText = z.string().regex(/^\S+ \S+$/, "a session is named `<harness> <native>`");

/** An agent was made while the host ran (`agent.create`); one in the composition needs no record. */
export const AgentCreated = record("agent.created", z.object({ agent: AgentName, definition: AgentDefinition }));

/** How an agent's new main session came to be: its first, or one seeded from the session before it. */
export const SessionOrigin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("first") }),
  z.object({
    kind: z.literal("seeded"),
    /** The session before it, which the seed points back to. */
    from: SessionRefText,
    /** What the seed is: the harness's own compaction summary, or a brief niwa read from the transcript. */
    seed: z.enum(["compaction", "transcript"]),
  }),
]);

/**
 * An agent got a new main session. The role it was started under and the version of each part of the
 * definition are written with it, so what a verdict of that session rested on is known later.
 */
export const AgentSessionStarted = record(
  "agent.session.started",
  z.object({
    agent: AgentName,
    session: SessionRefText,
    /** The id niwa gave the session (`s-…`). */
    id: z.string().min(1),
    /** The harness installation the session runs on. */
    harness: z.string().min(1),
    /** The role the harness was chosen by, when the agent runs on a role. */
    role: z.string().min(1).optional(),
    firstTurn: z.object({ turn: z.string(), receipt: DeliveryReceiptSchema.optional() }).optional(),
    parts: PartVersions,
    origin: SessionOrigin,
  }),
);

/** Who a turn is from. An address, or niwa itself (a handler, a workflow run): a fact niwa states. */
export const TurnAuthor = z.union([Address, z.object({ kind: z.literal("niwa"), by: z.string().min(1) }).strict()]);
export type TurnAuthor = z.output<typeof TurnAuthor>;

/** Where a fact came from, when it is more than its author: the digest of an attached session, from a locator up to one. */
export const TurnSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session-digest"),
    session: SessionRefText,
    /** The locator the digest was read after; absent from the start of the transcript. */
    from: z.string().min(1).optional(),
    /** The last record the digest holds: where the next digest of the session is read after. */
    upto: z.string().min(1),
  }),
  z.object({ kind: z.literal("task"), task: z.string().min(1) }),
]);
export type TurnSource = z.output<typeof TurnSource>;

/** The id of a turn: the id of the message it carries, or `fact-<hex>` for a fact. */
export const TurnId = z.string().regex(/^(msg|fact)-[0-9a-f]{6,16}$/);

/**
 * A turn waits in an agent's inbox: a message to its address, or a fact it was told.
 *
 * The author is kept as it was, and the turn carries no rights of its author: the session it reaches holds
 * its own grant, made from the agent's hands, whoever wrote.
 */
export const AgentTurnQueued = record(
  "agent.turn.queued",
  z.object({
    agent: AgentName,
    turn: TurnId,
    kind: z.enum(["message", "fact"]),
    author: TurnAuthor,
    replyTo: ReplyRoute.optional(),
    text: z.string(),
    source: TurnSource.optional(),
    attachment: z.string().optional(),
    more: z.boolean().optional(),
  }),
);

/** The main session and delivery path selected before this turn touches a harness. */
export const AgentTurnRouted = record("agent.turn.routed", z.object({
  agent: AgentName, turn: TurnId, session: SessionRefText.optional(), held: z.boolean(),
}));

/** A turn reached the agent's main session. */
export const AgentTurnDelivered = record(
  "agent.turn.delivered",
  z.object({ agent: AgentName, turn: TurnId, session: SessionRefText, receipt: DeliveryReceiptSchema }),
);

/** The session accepted a routed turn and answered it. Each turn has one reply. */
export const AgentTurnReplied = record("agent.turn.replied", z.object({
  agent: AgentName, turn: TurnId, text: z.string().min(1), replyTo: ReplyRoute,
}), {
  guard: {
    group: "agent.turn.reply",
    key: (reply) => reply.turn,
    initial: () => false,
    admit: (answered) => answered ? { code: "already-answered", reason: "The turn already has a reply" } : undefined,
    fold: () => true,
  },
});

/** A turn did not reach the agent: `unsent` when it surely did not go, `possibly-sent` when it may have. */
export const AgentTurnFailed = record(
  "agent.turn.failed",
  z.object({ agent: AgentName, turn: TurnId, status: z.enum(["unsent", "possibly-sent"]), reason: z.string() }),
);

/**
 * A native session was attached to an agent. A session is attached to one agent: a new attachment replaces
 * the one before. `from` is the last record of the transcript when it was attached: what the agent learns
 * of the session begins after it, and what came before is in the briefing's place, not in a digest.
 */
export const AgentAttached = record(
  "agent.attached",
  z.object({ agent: AgentName, session: SessionRefText, cwd: z.string().min(1), from: z.string().min(1).optional(), pending: z.literal(true).optional() }),
);

/**
 * An attached session paused or ended: what it did since the last digest is due to its agent. Only the
 * sessions attached to an agent have one, so the workflow that reads the digest runs for them alone.
 */
export const AgentDigestDue = record("agent.digest.due", z.object({ agent: AgentName, session: SessionRefText, attachment: z.string(), ended: z.boolean() }));

/** A native session was let go of. */
export const AgentDetached = record("agent.detached", z.object({ agent: AgentName, session: SessionRefText }));

/** The journal position before an attach or detach starts changing a watch. */
export const AgentAttachmentChanging = record("agent.attachment.changing", z.object({ session: SessionRefText }));

/** A transcript boundary established without sending a fact. */
export const AgentDigestAdvanced = record("agent.digest.advanced", z.object({
  session: SessionRefText, attachment: z.string(), upto: z.string().optional(), operation: z.string(), more: z.boolean(),
}));

/** The record types the module declares. */
export const AGENT_TYPES = [AgentCreated, AgentSessionStarted, AgentTurnRouted, AgentTurnQueued, AgentTurnDelivered, AgentTurnReplied, AgentTurnFailed, AgentAttached, AgentDetached, AgentDigestDue, AgentAttachmentChanging, AgentDigestAdvanced] as const;

/**
 * The digests of attached sessions, as they reach an agent: what a plugin that takes them in (a memory)
 * subscribes to. The fact carries the agent, the text and where in the transcript it was read.
 */
export const SessionDigestTaken: Trigger<z.output<typeof AgentTurnQueued.schema>> = trigger(AgentTurnQueued, {
  name: "agent.turn.queued:session-digest",
  filter: { "source.kind": "session-digest" },
});

/** A section a plugin adds to every briefing: the action that writes it, asked with `{ agent }`, answering `{ text }`. */
export interface BriefingSection {
  /** The heading of the section. */
  readonly title: string;
  /** The action that writes it: input `BriefingSectionInput`, output `BriefingSectionOutput`. */
  readonly action: string;
}

/** Where a plugin offers a section of the briefing (`api.offer(AGENT_BRIEFING, { title, action })`). */
export const AGENT_BRIEFING: OfferKey<BriefingSection> = offerKey("agent.briefing", "agents");

/** What the action of a briefing section is asked with. */
export const BriefingSectionInput = z.object({ agent: AgentName });
/** What it answers: the text of the section; an empty text leaves the section out. */
export const BriefingSectionOutput = z.object({ text: z.string() });

/**
 * A section a plugin adds to the prompt of an agent's sessions: the action that writes it, asked with `{ agent }` when a
 * session of the agent starts, answering `{ text }`. It goes as a stable section after the agent's own prompt, so what it
 * says is read live at each start (a charter that grows), not fixed when the plugin is set up. An empty text leaves it out.
 */
export interface PromptSectionOffer {
  /** Its name among the sections of the offering plugin; the session sees it as `<plugin>:<id>`. */
  readonly id: string;
  /** The action that writes it: input `PromptSectionInput`, output `PromptSectionOutput`. */
  readonly action: string;
  /** The agent whose sessions it is for; absent, every agent's. */
  readonly agent?: string;
}

/** Where a plugin offers a section of the prompt of an agent's sessions (`api.offer(AGENT_PROMPT_SECTION, { id, action })`). */
export const AGENT_PROMPT_SECTION: OfferKey<PromptSectionOffer> = offerKey("agent.prompt", "agents");

/** What the action of a prompt section is asked with. */
export const PromptSectionInput = z.object({ agent: AgentName });
/** What it answers: the text of the section; an empty text leaves the section out. */
export const PromptSectionOutput = z.object({ text: z.string() });

/** One agent as the list shows it. */
export const AgentStatus = z.enum(["new", "working", "asleep"]);
export type AgentStatus = z.output<typeof AgentStatus>;

const AgentItem = z.object({
  name: AgentName,
  address: z.object({ kind: z.literal("agent"), id: AgentName }),
  /** Where the agent is defined: the composition, or `agent.create`. */
  source: z.enum(["config", "runtime"]),
  status: AgentStatus,
  /** The main session, when it has one. */
  session: SessionRefText.optional(),
});

export const agentCreate = actionRef("agent.create", {
  description:
    "Makes an agent while the host runs: its name, the harness or role it runs on, its prompt and character, its hands (the niwa actions its sessions see), its tools and its project. A name that is taken is refused. The agent sleeps until something is said to it.",
  input: AgentDefinition,
  output: z.object({ agent: AgentName, address: z.object({ kind: z.literal("agent"), id: AgentName }) }),
});

export const agentList = actionRef("agent.list", {
  description: "Lists the agents: the ones of the composition and the ones made with agent.create, with where each stands and its main session.",
  input: z.object({}),
  output: z.object({ items: z.array(AgentItem) }),
});

export const agentGet = actionRef("agent.get", {
  description: "Gets one agent: its definition, where it stands, its main session, the turns waiting in its inbox and the native sessions attached to it.",
  input: z.object({ agent: AgentName }),
  output: AgentItem.extend({
    definition: AgentDefinition,
    queued: z.number().int().nonnegative(),
    attached: z.array(z.object({ session: SessionRefText, cwd: z.string() })),
  }),
});

export const agentReply = actionRef("agent.reply", {
  description: "Reply once to the owner in the conversation of a turn delivered to this session. Use the turn ID in the incoming message.",
  input: z.strictObject({ turn: TurnId, text: z.string().min(1) }),
  output: z.object({ turn: TurnId }),
});

export const agentTell = actionRef("agent.tell", {
  description:
    "Says something to an agent: a message to its address, from the address the caller speaks as. It becomes a turn of the agent's main session, which wakes for it; the answer is not waited for.",
  input: z.object({ agent: AgentName, text: z.string().min(1), replyTo: ReplyRoute.optional() }),
  output: z.object({ message: z.string().min(1) }),
});

export const agentNotify = actionRef("agent.notify", {
  description:
    "Tells an agent a fact: a turn of its main session that says what happened, from whoever states it. A fact carries no right of its author: it is never the owner's decision.",
  input: z.object({ agent: AgentName, text: z.string().min(1), source: z.object({ kind: z.literal("task"), task: z.string().min(1) }).optional() }),
  output: z.object({ turn: TurnId }),
});

export const agentAttach = actionRef("agent.attach", {
  description:
    "Attaches a native session to an agent (the default agent when none is named) and answers the agent's briefing. The session is named by its harness installation or its kind and its native id; a session is attached to one agent, and a new attachment replaces the one before. The session is watched from now on, and what it does reaches the agent as digests at its pauses.",
  input: z
    .object({
      agent: AgentName.optional(),
      /** The harness installation the session belongs to. */
      harness: z.string().min(1).optional(),
      /** The kind of harness, when the caller knows only that: the installation of that kind is found. */
      kind: z.string().min(1).optional(),
      native: z.string().min(1),
      cwd: z.string().min(1),
      /** The process of the harness the session runs in, when the caller knows it: its exit is a sign of the session's end. */
      pid: z.number().int().positive().optional(),
    })
    .refine((input) => input.harness !== undefined || input.kind !== undefined, "the session needs its harness or its kind"),
  output: z.object({ agent: AgentName, session: SessionRefText, replaced: AgentName.optional(), watching: z.boolean(), pending: z.literal(true).optional(), briefing: z.string() }),
});

export const agentDetach = actionRef("agent.detach", {
  description: "Lets go of a native session attached to an agent: it is no longer watched for the agent.",
  input: z.object({ session: SessionRefText }),
  output: z.object({ agent: AgentName.optional() }),
});

export const agentAttachment = actionRef("agent.attachment", {
  description: "The agent a native session is attached to, and the locator its last digest was read up to (or the one it was attached at).",
  input: z.object({ session: SessionRefText }),
  output: z.object({ agent: AgentName.optional(), attachment: z.string().optional(), pending: z.literal(true).optional(), upto: z.string().min(1).optional() }),
});

/** Read and publish the next bounded part of the current attachment's transcript. */
export const agentDigestRead = actionRef("agent.digest.read", {
  description: "Reads a part of an attached session and commits its digest if its attachment and starting position still match.",
  input: z.object({ session: SessionRefText, attachment: z.string(), from: z.string().optional(), pending: z.boolean().optional(), ended: z.boolean() }),
  output: z.object({ more: z.boolean(), stale: z.literal(true).optional(), upto: z.string().optional() }),
});

export const agentBriefing = actionRef("agent.briefing", {
  description:
    "The briefing of an agent: where its work stands, what waits in its inbox, the tasks it asked for that are open, its questions to the owner that wait, the latest facts it was told, and the sections other plugins add.",
  input: z.object({ agent: AgentName }),
  output: z.object({ text: z.string() }),
});

export const agentBounds = actionRef("agent.bounds", {
  description:
    "What an agent may reach: its hands (the niwa actions its sessions see), the tools of the harness, its project, and the rules its main session holds. A turn never widens them, whoever wrote it.",
  input: z.object({ agent: AgentName }),
  output: z.object({
    agent: AgentName,
    hands: z.array(z.string()),
    tools: AgentTools,
    project: AgentProject.optional(),
    harness: z.string().optional(),
    role: z.string().optional(),
    /** The rules of the main session's grant, when it has a session. */
    grant: z.array(z.string()).optional(),
  }),
});
