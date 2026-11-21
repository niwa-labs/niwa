/**
 * The sessions module: a session as niwa sees it, whatever the harness.
 *
 * The plugin registers:
 *
 * - `session.list` — the sessions there are, from the catalog and from the reading sides;
 * - `session.belong` — says whom a session serves, with the source of the choice;
 * - `session.read` — the transcript of one session, read through the harness's reading side and
 *   never journaled;
 * - `session.search` — a text search through the transcript of one session, through the same
 *   reading side, with the index and a snippet of each record that matched;
 * - `session.running` — what is running now, and what cannot be known;
 * - `session.start` — starts a session, and returns as soon as the harness has named it; the
 *   prompt is the session's first turn, and the start says what became of it without waiting
 *   for its end;
 * - `session.resume` — resumes a session;
 * - `session.send` — sends into a session and says what happened to the message;
 * - `session.interrupt` — interrupts a running turn, only where the harness declares it;
 * - `session.ask` — asks a session and returns a value that passed a schema;
 * - `session.open-questions` — the open questions of the session a niwa MCP server serves, found
 *   by the mark the server was given, each with the schema its answer must pass.
 *
 * The signs of life the control side reports are written as `session.*` records.
 */

import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  AccessClosed,
  AccessGranted,
  Address,
  DESCRIPTION_MAX,
  EntityDescription,
  IdIndex,
  JsonSchemaValue,
  TOKEN_ENV,
  UnknownId,
  ValidationError,
  accessMine,
  action,
  assertNever,
  effectPossibleAfter,
  grant,
  owner,
  rule,
  ruleText,
  seq,
  specsOf,
  toolNameOf,
  valueSchemaOf,
} from "@niwa-labs/core";
import { COCKPIT_MODULE, plugin, bindingOf } from "@niwa-labs/plugin";
import { fileURLToPath } from "node:url";
import type { ActionContext, Caller, Grant, JournalReader, JsonValue, Timestamp, Token } from "@niwa-labs/core";
import type { Plugin, CallerBinding } from "@niwa-labs/plugin";
import {
  DeliveryReceiptSchema,
  HarnessInstanceRegistry,
  InputNotSent,
  InputPossiblySent,
  blocksOf,
  outcomeOf,
  requireAbility,
  requireLaunch,
  requireOwnBlocks,
  requireTools,
  supports,
} from "@niwa-labs/harness";
import { WorktreeCreated, gitWorktreeCreate } from "@niwa-labs/git/records";
import { readTranscript, searchSession } from "@niwa-labs/history";
import type { Worktree, WorktreeOption } from "@niwa-labs/git/records";
import type {
  DeliveryReceipt,
  Harness,
  HarnessBinding,
  InputOutcome,
  KindOptions,
  McpServerSpec,
  ModelName,
  OptionBlocks,
  PermissionMark,
  SessionControl,
  SessionId,
  SessionInfo,
  SessionReading,
  VisibleActions,
} from "@niwa-labs/harness";
import { EnvNameSchema, onBoxManifest, requireBox } from "@niwa-labs/sandbox";
import type { BoxRecord, BoxSandboxName } from "@niwa-labs/sandbox";
import { RequestCreated, requestOpen } from "@niwa-labs/requests/records";

import { inheritedLaunch, isLaunchRule, launchOf, toolsOfSession, withProfile } from "./box.ts";
import type { GrantLaunch } from "./box.ts";
import { SessionRefusal } from "./refusal.ts";
import { REVERSE_TYPES, installReverse } from "./reverse.ts";
import { askNonNative, questionText, submitAnswerAction, SUBMIT_ANSWER_ACTION } from "./ask.ts";
import { SessionCatalog } from "./catalog.ts";
import type { SessionEntry } from "./catalog.ts";
import { SessionRefSchema, sessionOf, sessionRef } from "./identity.ts";
import type { NiwaSessionId, SessionRef } from "./identity.ts";
import { HarnessCaps } from "./caps.ts";
import type { Slot } from "./caps.ts";
import { PromptInputSchema, promptFrom } from "./prompt.ts";
import {
  SESSION_TYPES,
  BelongingSource,
  ActivityToolSchema,
  SessionActivity,
  SessionAdvisor,
  SessionBelongs,
  SessionBoxManifest,
  SessionInputSending,
  SessionInputSettled,
  SessionStartNamed,
  SessionStartReserved,
  SessionStartUnsent,
  SessionEnded,
  SessionMarked,
  SessionModel,
  SessionStarted,
  SessionTurnEnded,
  SessionTurnStarted,
  SessionUnknownVariant,
  sameAddress,
  SESSION_SEND,
} from "./records.ts";
import type { SessionSendInput, SessionSendOutput } from "./records.ts";
import {
  SessionRefInput,
  sessionAsk,
  sessionBelong,
  sessionGet,
  sessionEnd,
  sessionInterrupt,
  sessionList,
  SESSION_LIST_DEFAULT,
  SESSION_START_FIELDS,
  sessionOpenQuestions,
  sessionRead,
  sessionResume,
  harnessGet,
  harnessList,
  sessionRunning,
  sessionSearch,
  sessionSend,
  sessionStart,
} from "./actions.ts";
import { VisibleActionsInputSchema, visibleActionsOf } from "./visible.ts";
import type { VisibleActionsInput } from "./visible.ts";

const SESSION_TYPE_NAMES = SESSION_TYPES.map((type) => type.name);

/** The plugin name. */
const PLUGIN_NAME = "sessions";

/** How many sessions `session.running` lists of each kind when it is not told. */
const DEFAULT_RUNNING_LIMIT = 20;

/** Where a page of sessions ends: the activity time and the ref of its last session. */
const PageCursor = z.tuple([z.number(), z.string()]);

const recency = (entry: SessionEntry): number => entry.lastActivityAt ?? entry.startedAt ?? 0;

/**
 * One page of the sessions, the most recently active first. The cursor names the last session
 * given, not an offset, so a session that appears or ends between two calls moves none of the
 * others across a page.
 */
function pageOf(entries: readonly SessionEntry[], limit: number, cursor: string | undefined): { page: SessionEntry[]; nextCursor?: string } {
  const ordered = [...entries].sort((a, b) => recency(b) - recency(a) || a.ref.localeCompare(b.ref));
  let start = 0;
  if (cursor !== undefined) {
    let after: z.infer<typeof PageCursor>;
    try {
      after = PageCursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    } catch {
      throw new Error("the cursor is not one that session.list gave: pass nextCursor of the previous page unchanged");
    }
    start = ordered.findIndex((entry) => recency(entry) < after[0] || (recency(entry) === after[0] && entry.ref.localeCompare(after[1]) > 0));
    if (start < 0) start = ordered.length;
  }
  const page = ordered.slice(start, start + limit);
  const last = page.at(-1);
  if (last === undefined || start + limit >= ordered.length) return { page };
  return { page, nextCursor: Buffer.from(JSON.stringify([recency(last), last.ref])).toString("base64url") };
}

/** A session as one line: its id (the pointer for a session niwa did not start), the time of its last sign of life, its model, and its title. */
function runningLine(entry: SessionEntry): string {
  const active = entry.lastActivityAt === undefined ? "" : new Date(entry.lastActivityAt).toTimeString().slice(0, 8);
  const title = (entry.title ?? "").replace(/\s+/g, " ").trim();
  return [entry.id ?? entry.ref, active, entry.model ?? "", title.length > 60 ? `${title.slice(0, 59)}…` : title].filter((part) => part !== "").join("  ");
}

/** What the plugin is given: the harness installations it may read from. */
export interface SessionsOptions {
  /**
   * The installations, each with the sides that serve it (`kind.bind(...)`): the bindings
   * themselves, or the registry they are kept in. Two installations of one kind are two
   * bindings, each with its own sides.
   */
  readonly harnesses?: readonly HarnessBinding[] | HarnessInstanceRegistry;
  /**
   * How niwa's own MCP server is started, for the sessions that may see niwa actions.
   *
   * The command is the program and its arguments, which carry the home of the host. Without it a session that may see niwa actions cannot be
   * started: the start is refused, not silently made without the server.
   */
  readonly niwaMcp?: NiwaMcp;
  /**
   * The sandbox a session whose grant has `write:` or `net:` rules runs in. Default `srt`. Where
   * it is not available such a session does not start.
   */
  readonly sandbox?: BoxSandboxName;
  /**
   * The ceiling of a harness, by its id: how many of its sessions may run a turn at once on this host.
   * A start or a send over it waits until a turn ends; a sleeping session holds no slot. Absent, a
   * harness has none.
   */
  readonly caps?: Readonly<Record<string, number>>;
}

/**
 * How niwa's own MCP server is started.
 *
 * The arguments carry the home; the environment is the server's own and holds only what the
 * session may see.
 */
export interface NiwaMcp {
  /** The program that starts the server. */
  readonly command: string;
  /** The arguments of the program. */
  readonly args: readonly string[];
}

/** The name the niwa MCP server is known by in a session. */
const NIWA_MCP_NAME = "niwa";

/**
 * The ids niwa gave the sessions it started, each with the pointer it names, from the journal.
 *
 * The seed of an id is the operation of the starting call, which is the start of the record's own id.
 */
function sessionIdsOf(journal: JournalReader | undefined): { id: NiwaSessionId; ref: SessionRef; seed: string }[] {
  if (journal === undefined) return [];
  return journal.find({ type: SessionStarted.name }).flatMap((stored) => {
    const parsed = SessionStarted.schema.safeParse(stored.data);
    return parsed.success ? [{ id: parsed.data.id, ref: parsed.data.session, seed: stored.id.replace(/\/emit\/\d+$/, "") }] : [];
  });
}

/** How long stopping a control side waits for the records its streams of life leave. */
const FOLLOWER_WAIT_MS = 1_000;

/** The least time between two `session.activity` records of one session. */
const ACTIVITY_EVERY_MS = 5_000;

/** How much of a message a harness sent that niwa does not know is kept in its record. */
const UNKNOWN_RAW_CHARS = 16_384;

/** The message as it arrived, or its beginning: a message may carry the whole output of a command. */
function keptRaw(raw: JsonValue): JsonValue {
  const text = JSON.stringify(raw);
  return text.length <= UNKNOWN_RAW_CHARS ? raw : { truncated: true, chars: text.length, head: text.slice(0, UNKNOWN_RAW_CHARS) };
}

/**
 * The sessions plugin.
 *
 * It keeps no record state of its own: the catalog is built from niwa's session records and from
 * what the reading sides list. Nothing is copied out of a harness. The only thing held in memory
 * is the sessions whose signs of life are followed. A question that waits for an answer is a
 * request, so it is in the journal and not in this process.
 */
export function sessions(options: SessionsOptions = {}): SessionsPlugin {
  const bindings = resolveBindings(options);
  // The session a mark names, once the plugin is installed: what the binding of a session's own client reads.
  let sessionOfClientMark: ((mark: string) => SessionRef | undefined) | undefined;
  // A turn left open before this moment proves nothing about now.
  const bootedAt = Date.now() as Timestamp;
  // The sessions whose signs of life are being followed: one loop per session.
  const followed = new Set<SessionRef>();
  /** The sessions `session.end` ended: their end is written once, by it, not again when their stream closes. */
  const ending = new Set<SessionRef>();
  // The sessions niwa was asked to interrupt: their next turn end is written as interrupted.
  const interrupting = new Set<SessionRef>();
  // The numbering of each session's turns. A harness counts its turns from 1 in each process: the
  // journal's last number is where a process that was launched again goes on, so a turn is known
  // by the same number in its records and in the receipt of a message sent into it.
  const turnCounts = new Map<SessionRef, { last: number; offset: number }>();
  /** The starts under an operation that are running now: a retry waits for the one running. */
  const startsRunning = new Map<string, { digest: string; answer: Promise<z.output<typeof sessionStart.output>> }>();
  // The loops that follow them, by control side, so that stopping a side waits for the last
  // records of its sessions to be written.
  const followers = new Map<SessionControl, Set<Promise<void>>>();
  // The launches that are waiting for their box to be recorded, by mark: the funnel's manifest
  // listener is global, and a manifest is the business of the plugin that asked for that box.
  const boxManifests = new Map<string, (data: BoxManifest) => Promise<unknown>>();

  /**
   * The MCP servers a session is given, from the actions it may see.
   *
   * A session that may see no niwa action is given no server: it has no use for one. A session
   * that may see some is given niwa's own server, which shows it exactly those actions. Without
   * the `niwaMcp` option the server cannot be started, and the start is refused — a session that
   * was promised niwa's actions and gets none is worse than a refusal.
   *
   * The server is given a mark (`NIWA_SESSION_MARK`): the pairing of the mark with the session is
   * written once the session is named, so the server can ask what the session it serves is asked.
   */
  const serversOf = (
    actions: readonly string[],
    mark: string,
    token: Token,
  ): readonly McpServerSpec[] | undefined => {
    if (actions.length === 0) return undefined;
    if (options.niwaMcp === undefined) {
      throw new SessionRefusal(
        "no-niwa-mcp",
        "the session may see niwa actions, but no niwa MCP server was given to start it",
      );
    }
    return [
      {
        name: NIWA_MCP_NAME,
        command: options.niwaMcp.command,
        args: options.niwaMcp.args,
        env: { NIWA_VISIBLE: actions.join(","), NIWA_SESSION_MARK: mark, [TOKEN_ENV]: token },
        tools: actions.map(toolNameOf),
      },
    ];
  };

  /**
   * What a harness names the tools of niwa's own server (`mcp__<server>__<tool>`), for a session that is given the
   * server: the session's grant is what the server shows, so a request to call one of them is not put to anybody.
   */
  const ownToolPrefix = (actions: readonly string[]): string | undefined =>
    actions.length === 0 ? undefined : `mcp__${NIWA_MCP_NAME}__`;

  /**
   * The actions a session of a harness may see, with the one that answers a question.
   *
   * A harness that cannot answer natively is asked through the request, and the session
   * answers it by calling `submit-answer`. That action must be among the ones the session
   * sees, or the question cannot be answered at all: it is added here.
   *
   * A harness that answers natively has no use for that action: it is not added, and one that
   * was given is taken away, so a session of such a harness needs no server for it.
   *
   * A session that is given no niwa action at all sees none: nothing is implied, and a
   * session that sees nothing has no server to call the action through.
   */
  const visibleFor = (harness: string, input: VisibleActionsInput | undefined): VisibleActions => {
    const visible = visibleActionsOf(input);
    if (input === undefined || visible.actions.length === 0) return visible;
    if (supports(instanceOf(bindings, harness), "control", "structuredOutput")) {
      if (!visible.actions.includes(SUBMIT_ANSWER_ACTION)) return visible;
      return {
        actions: visible.actions.filter((name) => name !== SUBMIT_ANSWER_ACTION),
        disabledTools: visible.disabledTools,
      };
    }
    if (visible.actions.includes(SUBMIT_ANSWER_ACTION)) return visible;
    return { actions: [...visible.actions, SUBMIT_ANSWER_ACTION], disabledTools: visible.disabledTools };
  };

  /**
   * The address a client speaks as: the client a session's own token gives is its session, so a
   * session answers a question addressed to it and no other; every other client speaks as
   * `fallback` says. The composition hands it to the requests module (`requests({ bind })`).
   */
  const bind = (fallback: CallerBinding = bindingOf()): CallerBinding => {
    return (caller) => {
      const principal = caller.kind === "client" ? caller.principal : undefined;
      const session = principal?.kind === "session" ? sessionOfClientMark?.(principal.id) : undefined;
      if (session === undefined) return fallback(caller);
      const id = sessionOf(session);
      return { kind: "session", harness: id.harness, id: id.native };
    };
  };
  /** The one who started a session: the address its caller speaks as. A run asks the owner, as a script's own ask does. */
  const starterOf = (caller: Caller): Address => {
    const principal = caller.kind === "client" ? caller.principal : undefined;
    if (principal?.kind === "run") return owner;
    return bind()(caller) ?? owner;
  };

  const made = plugin(PLUGIN_NAME, (api) => {
    // The page of this plugin in the cockpit: a client module, offered by the path of its source.
    api.offer(COCKPIT_MODULE, { id: "sessions", entry: fileURLToPath(new URL("./cockpit/index.tsx", import.meta.url)) });
    api.declare(...SESSION_TYPES, ...REVERSE_TYPES);
    const reverse = installReverse(api);
    const sessionIds = new IdIndex("session", () => sessionIdsOf(api.journal?.()));
    const caps = new HarnessCaps(options.caps ?? {}, {
      journal: () => api.journal?.(),
      untilCommit: (ms) => api.untilCommit(ms),
      followed: () => followed,
      harnessOf: (ref) => sessionOf(ref).harness,
      servedAfter: () => servedAfter,
    });
    // The last record before this host served: turns that began by then ran in processes of another host.
    let servedAfter = seq(0);
    api.service(() => {
      servedAfter = api.journal?.()?.last() ?? seq(0);
      return () => {};
    });

    /**
     * The pointer of the session a caller named: the id niwa gave it or any text that names one, or
     * the pair of a session niwa did not start. A text that names no session is `UnknownId`.
     */
    const refOf = (input: z.output<typeof SessionRefInput>): SessionRef => {
      if (typeof input !== "string") return SessionRefSchema.parse(`${input.harness} ${input.native}`);
      if (input.includes(" ")) return SessionRefSchema.parse(input);
      const id = sessionIds.require(input);
      const found = sessionIdsOf(api.journal?.()).find((entry) => entry.id === id);
      if (found === undefined) throw new UnknownId(input, "session");
      return found.ref;
    };
    api.action(submitAnswerAction(() => api.journal?.()));

    /**
     * The control sides this plugin holds are stopped when the host stops.
     *
     * A control side owns processes: the harness CLI, and the MCP servers the CLI was given.
     * Nothing it started may outlive the host that started it, so every side is disposed here —
     * once per side, and a side that fails to stop does not keep the others alive.
     */
    api.service(() => {
      const stopped = new Set<SessionControl>();
      return async (): Promise<void> => {
        for (const binding of bindings) {
          const control = binding.control;
          if (control === undefined || stopped.has(control)) continue;
          stopped.add(control);
          try {
            if (control.dispose !== undefined) {
              await control.dispose();
              // Disposing ends the streams of life: the records they leave are written first.
              // A side whose streams stay open does not hold the stop: the wait is short.
              await Promise.race([
                Promise.allSettled([...(followers.get(control) ?? [])]),
                new Promise<void>((resolve) => setTimeout(resolve, FOLLOWER_WAIT_MS).unref()),
              ]);
            }
          } catch (error) {
            // One side that does not stop keeps the others from stopping: the rest are stopped.
            console.error(
              `niwa: stopping the control side of "${binding.instance.id}" failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      };
    });

    /** The manifest of every box a session of this plugin is started in is written before its process starts. */
    api.service(() => {
      const stop = onBoxManifest(async (made) => {
        const write = made.mark === undefined ? undefined : boxManifests.get(made.mark);
        if (made.mark === undefined || write === undefined) return;
        await write(manifestRecord(made, made.mark));
      });
      return async () => stop();
    });

    /**
     * A question niwa asked of a session reaches the session.
     *
     * The request is what waits for the answer; the session is told nothing by it. So the
     * session that may answer gets the question as a message, with the id of the request it
     * must answer by, and how to answer it.
     *
     * The delivery is a step: a step is not made twice, so a question is not asked twice
     * after a restart.
     */
    api.on(RequestCreated, { id: "session-question" }, async (data, step) => {
      if (data.to.kind !== "session") return;
      await step<SessionSendInput, SessionSendOutput>(SESSION_SEND, {
        session: `${data.to.harness} ${data.to.id}`,
        message: questionText({
          request: data.id,
          question: data.question,
          input: data.input,
        }),
      });
    });

    /** The control side that serves a session, refused before anything is attempted if it cannot. */
    const controlOf = (input: z.output<typeof SessionRefInput>, ability: ControlAbility) => {
      const ref = refOf(input);
      const id = sessionOf(ref);
      return { ref, id, control: controlFor(bindings, id.harness, ability) };
    };

    /**
     * Write the signs of life a control side reports as records.
     *
     * They have no calling action — they arrive while the harness works — so they go through the
     * plugin's own `emit`. A record says that something happened, never what.
     */
    const follow = (control: SessionControl, ref: SessionRef, id: SessionId): void => {
      if (followed.has(ref)) return;
      followed.add(ref);
      // A busy turn reports a sign of life many times a second: one record in a few seconds says it as well.
      let activeAt = -Infinity;
      // The latest decision seen since the last record: a record carries it, so a burst of marked
      // tool calls is throttled like the rest and says what was decided last.
      let pending: PermissionMark | undefined;
      // The latest tool name seen since the last record, when it is a short identifier.
      let pendingTool: string | undefined;
      // The model the session is known to run: the harness says it again on every launch, and a
      // record says it once.
      let named = modelOf(ref);
      // The unknown variants already written: one record for each.
      const unknown = new Set<string>();
      const loop = (async () => {
        try {
          for await (const event of control.life(id)) {
            switch (event.kind) {
              case "model":
                if (event.model !== named) {
                  named = event.model;
                  await api.emit(SessionModel, { session: ref, model: event.model });
                }
                break;
              case "turn-started":
                activeAt = -Infinity;
                pending = undefined;
                pendingTool = undefined;
                // An interrupt that ended no turn says nothing about the turn that begins now.
                interrupting.delete(ref);
                await api.emit(SessionTurnStarted, { session: ref, turn: beginning(ref, event.turn) });
                break;
              case "turn-ended": {
                // An interrupt niwa asked for says how the turn ended; otherwise the harness does.
                const interrupted = interrupting.delete(ref);
                await api.emit(SessionTurnEnded, {
                  session: ref,
                  turn: numbered(ref, event.turn),
                  how: interrupted ? "interrupted" : (event.outcome ?? "completed"),
                });
                break;
              }
              case "activity":
                if (event.permission !== undefined) pending = event.permission;
                if (event.tool !== undefined) {
                  const tool = ActivityToolSchema.safeParse(event.tool);
                  if (tool.success) pendingTool = tool.data;
                }
                if (Date.now() - activeAt >= ACTIVITY_EVERY_MS) {
                  activeAt = Date.now();
                  const permission = pending;
                  const tool = pendingTool;
                  pending = undefined;
                  pendingTool = undefined;
                  await api.emit(SessionActivity, {
                    session: ref,
                    ...(permission === undefined ? {} : { permission }),
                    ...(tool === undefined ? {} : { tool }),
                  });
                }
                break;
              // Rare and meaningful: each is written, not throttled.
              case "advisor": {
                const { kind: _kind, at: _at, ...advisor } = event;
                await api.emit(SessionAdvisor, { session: ref, ...advisor });
                break;
              }
              case "unknown-variant": {
                // One record for each variant: the first message of it is the one worth reading.
                const kind = `${event.protocol} ${event.variant}`;
                if (!unknown.has(kind)) {
                  unknown.add(kind);
                  await api.emit(SessionUnknownVariant, {
                    session: ref,
                    protocol: event.protocol,
                    variant: event.variant,
                    raw: keptRaw(event.raw),
                  });
                }
                break;
              }
              default:
                assertNever(event, "sign of life");
            }
          }
          // The control side closes the stream of a session only when the session is over.
          if (!ending.has(ref)) await api.emit(SessionEnded, { session: ref, reason: "the control side closed the session" });
        } catch {
          // The stream stopped, or the host closed. What was written stays; the state of the
          // session reads as unknown from here on.
        } finally {
          followed.delete(ref);
        }
      })();
      const loops = followers.get(control) ?? new Set<Promise<void>>();
      followers.set(control, loops);
      loops.add(loop);
      void loop.finally(() => loops.delete(loop));
    };

    /**
     * The catalog, merged with what the reading sides list.
     *
     * A side that cannot list is named in `unreadable`: its sessions may exist, and the answer
     * must not read as "there are none".
     */
    const survey = async (harness: string | undefined, cwd: string | undefined, managedOnly = false) => {
      const journal = api.journal?.();
      const catalog = SessionCatalog.fromRecords(
        journal === undefined ? [] : journal.since(seq(0), SESSION_TYPE_NAMES),
        bootedAt,
      );
      // The sessions niwa runs are the ones its own records name; the others are found on the machine.
      const managed = catalog.all();
      const own = new Set(managed.map((entry) => entry.ref));
      const { listed, unreadable } = managedOnly
        ? { listed: [], unreadable: [] }
        : await listFromSides(bindings, harness, cwd);
      for (const info of listed) {
        catalog.remember({
          ref: sessionRef(info.id),
          title: info.title,
          cwd: info.cwd,
          startedAt: info.startedAt,
          lastActivityAt: info.updatedAt,
          state: "unknown",
        });
      }
      const entries = (managedOnly ? managed : catalog.all())
        .filter((entry) => harness === undefined || sessionOf(entry.ref).harness === harness)
        .filter((entry) => cwd === undefined || entry.cwd === cwd);
      return { catalog, entries, unreadable, own };
    };

    // The sessions niwa runs that work now, for `niwa.host.status`.
    api.summarize(() => {
      const journal = api.journal?.();
      const catalog = SessionCatalog.fromRecords(journal === undefined ? [] : journal.since(seq(0), SESSION_TYPE_NAMES), bootedAt);
      return { running: catalog.all().filter((entry) => entry.state === "running").length };
    });

    /**
     * Does the journal already hold this belonging?
     *
     * The record is one fact of the pair: the same session and the same address are one
     * belonging, however many times they are said.
     */
    const belongs = (ref: SessionRef, to: Address): boolean => {
      const journal = api.journal?.();
      if (journal === undefined) return false;
      return journal
        .find({ type: SessionBelongs.name, field: "session", equals: ref })
        .some((stored) => {
          const parsed = SessionBelongs.schema.safeParse(stored.data);
          if (!parsed.success) return false;
          return parsed.data.session === ref && sameAddress(parsed.data.to, to);
        });
    };

    api.action(
      action(sessionList, {
        // A read changes nothing: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          const { catalog, entries, unreadable } = await survey(input.harness, input.cwd, input.managedOnly);
          const { page, nextCursor } = pageOf(entries, input.limit ?? SESSION_LIST_DEFAULT, input.cursor);
          return {
            sessions: page,
            total: entries.length,
            ...(nextCursor === undefined
              ? {}
              : { nextCursor, hint: `${page.length} of ${entries.length} sessions shown: pass nextCursor as cursor for the next page, or narrow by harness or cwd.` }),
            belongings: catalog.belongings(new Set(page.map((entry) => entry.ref))),
            unreadable,
          };
        },
      }),
    );

    api.action(
      action(sessionGet, {
        // A read changes nothing: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          const ref = refOf(input.id);
          const { catalog } = await survey(sessionOf(ref).harness, undefined);
          const entry = catalog.get(ref);
          if (entry?.id === undefined) throw new UnknownId(input.id, "session");
          return { ...entry, id: entry.id, belongings: catalog.belongings(new Set([ref])) };
        },
      }),
    );

    api.action(
      action(sessionBelong, {
        // The belonging is one fact: the same session and the same address are one record, so a
        // call that was cut off may be made again.
        recovery: "repeat",
        effect: "record",
        world: "niwa",
        run: async (input, ctx) => {
          const ref = refOf(input.session);
          const to = input.to;
          // The write is skipped when the journal already holds this belonging: saying it twice
          // is one fact, not two.
          if (belongs(ref, to)) {
            return { session: ref, to, source: input.source, known: true };
          }
          await ctx.emit(SessionBelongs, { session: ref, to, source: input.source });
          return { session: ref, to, source: input.source, known: false };
        },
      }),
    );

    api.action(
      action(sessionRead, {
        // A read changes nothing: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "local",
        run: async (input) => {
          const id = sessionOf(refOf(input.session));
          return await readTranscript(bindings.find((candidate) => candidate.instance.id === id.harness), id, input);
        },
      }),
    );

    api.action(
      action(sessionSearch, {
        // A search reads and changes nothing: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "local",
        run: async (input) => {
          const id = sessionOf(refOf(input.session));
          return await searchSession(bindings.find((candidate) => candidate.instance.id === id.harness), id, input);
        },
      }),
    );

    // The harnesses as they are bound: the same bindings session.start refuses a foreign block by, so what these say
    // and what a start takes agree.
    const harnessItem = (binding: HarnessBinding) => ({
      name: binding.instance.id,
      kind: binding.instance.kind,
      ...(binding.instance.model === undefined ? {} : { model: binding.instance.model }),
      capabilities: binding.instance.sides,
      ...(binding.options === undefined
        ? {}
        : { block: binding.options.block, options: JsonSchemaValue.parse(z.toJSONSchema(binding.options.schema, { io: "input" })) }),
    });
    api.action(
      action(harnessList, {
        // A read of how the harnesses are bound: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: () => ({ items: bindings.map(harnessItem) }),
      }),
    );
    api.action(
      action(harnessGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          const binding = bindings.find((one) => one.instance.id === input.name);
          if (binding === undefined) throw new Error(`harness "${input.name}" is not known: harness.list names the harnesses`);
          return {
            ...harnessItem(binding),
            machine: binding.instance.machine,
          };
        },
      }),
    );

    api.action(
      action(sessionRunning, {
        // A read changes nothing: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input) => {
          const { entries, unreadable, own } = await survey(input.harness, undefined);
          const limit = input.limit ?? DEFAULT_RUNNING_LIMIT;
          const shown = entries.filter((entry) => input.all === true || own.has(entry.ref));
          const latestFirst = (state: SessionEntry["state"]): SessionEntry[] =>
            shown.filter((entry) => entry.state === state).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
          const running = latestFirst("running");
          const unknown = latestFirst("unknown");
          return {
            running: running.slice(0, limit).map(runningLine),
            unknown: unknown.slice(0, limit).map(runningLine),
            omitted: Math.max(0, running.length - limit) + Math.max(0, unknown.length - limit),
            unreadable,
          };
        },
      }),
    );

    /**
     * The token of a session that is being started or resumed.
     *
     * The session is the principal and its mark names it: the session has no name until the
     * harness gives it one, and the mark is what the pairing records. The token carries what the
     * session sees, so the core refuses every call outside it, and it is the one thing the
     * session's process is given.
     */
    const tokenFor = (mark: string, rules: Grant, parent: Caller): Token =>
      api.issueToken("session", mark, { grant: rules, parent });

    /**
     * The launch a grant makes: its tools and its box. A box that
     * cannot be had here stops the start: this runs before a mark, a token or a process exists.
     */
    const launchFor = async (rules: Grant, cwd: string | undefined, harness: string): Promise<GrantLaunch> => {
      const made = launchOf(rules, { home: api.home(), cwd: cwd ?? process.cwd(), socket: api.socket(), sandbox: options.sandbox ?? "srt" });
      const profile = bindings.find((binding) => binding.instance.id === harness)?.profile;
      const launch = made.box === undefined || profile === undefined ? made : { ...made, box: withProfile(made.box, profile, harness) };
      await requireBox(launch.box);
      return launch;
    };

    /** The launch as the control side takes it: the box carries the mark its manifest is recorded under. */
    const launchOptions = (launch: GrantLaunch, mark: string) => ({
      ...(launch.tools === undefined ? {} : { tools: launch.tools }),
      ...(launch.box === undefined ? {} : { box: { ...launch.box, mark } }),
    });

    /**
     * Runs the launch of a session whose process is born in a box, with the manifest of that box
     * written to the journal by the action that launches it, before the process starts.
     */
    const recording = async <T>(mark: string, launch: GrantLaunch, ctx: ActionContext, work: () => Promise<T>): Promise<T> => {
      if (launch.box === undefined) return await work();
      boxManifests.set(mark, (data) => ctx.emit(SessionBoxManifest, data));
      try {
        return await work();
      } finally {
        boxManifests.delete(mark);
      }
    };

    /**
     * The grant of a session: what the caller asked for, narrowed to what the caller has, and what
     * the module gives every session for itself.
     *
     * Asking for more than the caller has creates no session and answers with the masks refused.
     * The answering action is added to the request by the module for every session that cannot
     * answer natively, so it is not compared with the caller's rights. A launch verb the request
     * says nothing of (`tool:`, `write:`, `net:`) is taken from the caller's own rules: a child is
     * never wider than a limited caller, and an unlimited caller's child stays as it asked.
     */
    const grantOfSession = (caller: Caller, requested: VisibleActionsInput | undefined, visible: VisibleActions): Grant => {
      const asked = requested?.actions ?? [];
      const narrowed = api.narrow(caller, [...asked, ...inheritedLaunch(api.rights(caller), asked)]);
      if ("refused" in narrowed) {
        throw new SessionRefusal(
          "wider-than-caller",
          `the caller does not have ${narrowed.refused.join(", ")}: a session it starts cannot see more than it does`,
        );
      }
      const own = [...visible.actions.filter((name) => !asked.includes(name)), sessionOpenQuestions.name, accessMine];
      return grant([...specsOf(narrowed.rules), ...own]);
    };

    /** The session a mark names: the mark is what the pairing recorded when the session was started. */
    const sessionOfMark = (mark: string): SessionRef | undefined => {
      let session: SessionRef | undefined;
      for (const record of api.journal?.()?.since(seq(0), [SessionMarked.name]) ?? []) {
        const marked = SessionMarked.schema.safeParse(record.data);
        if (marked.success && marked.data.mark === mark) session = marked.data.session;
      }
      return session;
    };

    sessionOfClientMark = sessionOfMark;

    /** The latest `session.started` of a session, from the journal. */
    const startedOf = (ref: SessionRef): z.output<typeof SessionStarted.schema> | undefined =>
      api.journal?.()
        ?.find({ type: SessionStarted.name, field: "session", equals: ref })
        .flatMap((stored) => {
          const parsed = SessionStarted.schema.safeParse(stored.data);
          return parsed.success ? [parsed.data] : [];
        })
        .at(-1);

    /**
     * The last send of a session under an operation id, from the journal: the digest of its message,
     * and its outcome once it was settled. A send that has no outcome was cut off while it went.
     */
    const inputOf = (ref: SessionRef, operation: string): { digest: string; outcome?: InputOutcome } | undefined => {
      const journal = api.journal?.();
      if (journal === undefined) return undefined;
      const sent = journal
        .find({ type: SessionInputSending.name, field: "operation", equals: operation })
        .flatMap((stored) => {
          const parsed = SessionInputSending.schema.safeParse(stored.data);
          return parsed.success && parsed.data.session === ref ? [{ seq: stored.seq, digest: parsed.data.digest }] : [];
        })
        .at(-1);
      if (sent === undefined) return undefined;
      const settled = journal
        .find({ type: SessionInputSettled.name, field: "operation", equals: operation })
        .flatMap((stored) => {
          const parsed = SessionInputSettled.schema.safeParse(stored.data);
          return parsed.success && parsed.data.session === ref && stored.seq > sent.seq ? [parsed.data.outcome] : [];
        })
        .at(-1);
      return settled === undefined ? { digest: sent.digest } : { digest: sent.digest, outcome: settled };
    };

    /**
     * The start whose prompt was an input under an operation, from the journal: the digest of the input, and what
     * the start answered. A send under the operation is an input too, with another digest.
     */
    const startUnder = (operation: string): { digest: string; answer?: z.output<typeof sessionStart.output> } | undefined => {
      const journal = api.journal?.();
      if (journal === undefined) return undefined;
      const sent = journal
        .find({ type: SessionInputSending.name, field: "operation", equals: operation })
        .flatMap((stored) => {
          const parsed = SessionInputSending.schema.safeParse(stored.data);
          return parsed.success ? [parsed.data] : [];
        })
        .at(0);
      if (sent === undefined) return undefined;
      const issued = sessionIdsOf(journal).find((entry) => entry.ref === sent.session);
      const outcome = inputOf(sent.session, operation)?.outcome;
      // An input under the operation that is not the prompt of a start niwa made answers nothing but its conflict.
      if (issued === undefined) return { digest: sent.digest };
      const cwd = startedOf(sent.session)?.cwd;
      const made = cwd === undefined
        ? undefined
        : journal.find({ type: WorktreeCreated.name, field: "path", equals: cwd }).flatMap((stored) => {
            const parsed = WorktreeCreated.schema.safeParse(stored.data);
            return parsed.success ? [parsed.data] : [];
          }).at(-1);
      return {
        digest: sent.digest,
        answer: {
          session: issued.id,
          ref: sent.session,
          ...(outcome?.status === "accepted" ? { receipt: outcome.receipt } : {}),
          ...(made === undefined ? {} : { worktree: { id: made.id, path: made.path, branch: made.branch } }),
          operation,
        },
      };
    };

    /**
     * The last reservation of a start under an operation, from the journal: the digest it was made with, the
     * directory, the session its harness named, and whether it failed with nothing sent.
     */
    const reservationOf = (operation: string): { digest: string; cwd?: string; named?: SessionRef; released: boolean } | undefined => {
      const journal = api.journal?.();
      if (journal === undefined) return undefined;
      const last = journal
        .find({ type: SessionStartReserved.name, field: "operation", equals: operation })
        .flatMap((stored) => {
          const parsed = SessionStartReserved.schema.safeParse(stored.data);
          return parsed.success ? [{ seq: stored.seq, ...parsed.data }] : [];
        })
        .at(-1);
      if (last === undefined) return undefined;
      const after = <T>(type: { name: string; schema: z.ZodType<T> }): T[] =>
        journal.find({ type: type.name as never, field: "operation", equals: operation }).flatMap((stored) => {
          const parsed = type.schema.safeParse(stored.data);
          return parsed.success && stored.seq > last.seq ? [parsed.data] : [];
        });
      const named = after(SessionStartNamed).at(-1)?.session;
      return {
        digest: last.digest,
        ...(last.cwd === undefined ? {} : { cwd: last.cwd }),
        ...(named === undefined ? {} : { named }),
        released: after(SessionStartUnsent).length > 0,
      };
    };

    /** The number of the last turn the journal holds for a session. */
    const lastTurnOf = (ref: SessionRef): number =>
      Math.max(
        0,
        ...(api.journal?.()?.find({ type: SessionTurnStarted.name, field: "session", equals: ref }) ?? []).flatMap((stored) => {
          const parsed = SessionTurnStarted.schema.safeParse(stored.data);
          return parsed.success ? [parsed.data.turn] : [];
        }),
      );

    /** The turn counting of a session, started from the journal the first time it is needed. */
    const countOf = (ref: SessionRef): { last: number; offset: number } => {
      const known = turnCounts.get(ref);
      if (known !== undefined) return known;
      const made = { last: lastTurnOf(ref), offset: 0 };
      turnCounts.set(ref, made);
      return made;
    };

    /** The number a turn of the harness has in the records. */
    const numbered = (ref: SessionRef, turn: number): number => turn + countOf(ref).offset;

    /** The harness counts from 1 again: the next turn it names goes on after the last one written. */
    const restart = (ref: SessionRef): void => {
      const count = countOf(ref);
      count.offset = count.last;
    };

    /** A turn of the harness began: its number in the records, always after the last one written. */
    const beginning = (ref: SessionRef, turn: number): number => {
      const count = countOf(ref);
      if (turn + count.offset <= count.last) count.offset = count.last - turn + 1;
      count.last = turn + count.offset;
      return count.last;
    };

    /** The model the harness last named for a session, from the journal: `undefined` until it names one. */
    const modelOf = (ref: SessionRef): ModelName | undefined =>
      api.journal?.()
        ?.find({ type: SessionModel.name, field: "session", equals: ref })
        .flatMap((stored) => {
          const parsed = SessionModel.schema.safeParse(stored.data);
          return parsed.success ? [parsed.data.model] : [];
        })
        .at(-1);

    /**
     * What a session was last launched with, from the journal: the request its grant answered
     * and the cwd its box was made for (the box's own, else the one it started in). Nothing is recorded for a session niwa did not launch.
     *
     * The grant is the record of the last mark the session was given. The rules the module adds
     * to every session are left out of the request, as they are added again.
     */
    const lastLaunchOf = (ref: SessionRef): { request: VisibleActionsInput; cwd: string | undefined } | undefined => {
      const journal = api.journal?.();
      if (journal === undefined) return undefined;
      const marks = journal.find({ type: SessionMarked.name, field: "session", equals: ref });
      const mark = marks.flatMap((stored) => {
        const parsed = SessionMarked.schema.safeParse(stored.data);
        return parsed.success ? [parsed.data.mark] : [];
      }).at(-1);
      if (mark === undefined) return undefined;
      const granted = journal
        .find({ type: AccessGranted.name, field: "principal.id", equals: mark })
        .flatMap((stored) => {
          const parsed = AccessGranted.schema.safeParse(stored.data);
          return parsed.success && parsed.data.principal.kind === "session" ? [parsed.data.rules] : [];
        })
        .at(-1);
      if (granted === undefined) return undefined;
      const own = new Set<string>([sessionOpenQuestions.name, accessMine, SUBMIT_ANSWER_ACTION]);
      const actions = granted
        .map((spec) => rule(spec))
        .filter((each) => each.verb !== "call" || !own.has(each.name))
        .map((each) => (each.verb === "call" ? ruleText(each).slice("call:".length) : ruleText(each)));
      const boxed = journal
        .find({ type: SessionBoxManifest.name, field: "mark", equals: mark })
        .flatMap((stored) => {
          const parsed = SessionBoxManifest.schema.safeParse(stored.data);
          return parsed.success ? [String(parsed.data.spec.cwd)] : [];
        })
        .at(-1);
      const started = startedOf(ref)?.cwd;
      return { request: { actions }, cwd: boxed ?? (started === undefined ? undefined : String(started)) };
    };

    /**
     * A session whose grant was closed is stopped: the turn it runs is interrupted through
     * the action that does it, and its end is written. The token it holds buys nothing any more.
     */
    api.on(AccessClosed, { id: "session-grant-closed" }, async (data, step) => {
      if (data.principal.kind !== "session") return;
      const session = sessionOfMark(data.principal.id);
      if (session === undefined) return;
      // A harness that cannot interrupt, or a session with no turn, is not a reason to keep it.
      await step.outcome(sessionInterrupt, { session });
      await step.emit(SessionEnded, { session, reason: `its grant was closed: ${data.reason}` });
    });

    api.action(
      action(sessionStart, {
        // A harness names the session once: a start that was cut off may have made one
        // that nothing knows of, so it is not made again.
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        run: async (input, ctx) => {
          // The prompt is an input under an operation: a retry with it answers the session it made.
          const operation = input.operation ?? ctx.operationId;
          const digest = createHash("sha256").update(JSON.stringify(["start", input.harness, input.prompt])).digest("hex");
          const conflict = () => new SessionRefusal("operation-conflict", `operation "${operation}" was another input of a session`);
          // A retry while the start runs waits for it: the harness is asked once.
          const running = startsRunning.get(operation);
          if (running !== undefined) {
            if (running.digest !== digest) throw conflict();
            return await running.answer;
          }
          const before = startUnder(operation);
          if (before !== undefined) {
            if (before.digest !== digest || before.answer === undefined) throw conflict();
            return before.answer;
          }
          // A start that was cut off after it asked its harness is never asked again: the session it made is
          // answered when the harness named one, and otherwise its prompt may have gone with a session nobody knows.
          const reserved = reservationOf(operation);
          if (reserved !== undefined && !reserved.released) {
            if (reserved.digest !== digest) throw conflict();
            if (reserved.named === undefined) {
              throw new InputPossiblySent(instanceOf(bindings, input.harness).id, "start", "a start under this operation was cut off after it asked the harness for a session");
            }
            const ref = reserved.named;
            await ctx.emit(SessionStarted, {
              session: ref,
              id: sessionIds.issue(ctx.operationId),
              cwd: reserved.cwd,
              effort: input.effort,
              mode: input.mode,
              ...(input.tools === undefined || input.tools === "all" ? {} : { tools: input.tools }),
              ...(input.stuckAfter === undefined ? {} : { stuckAfter: input.stuckAfter }),
            });
            await ctx.emit(SessionInputSending, { session: ref, operation, digest });
            const reason = "the start was cut off after its harness named the session, while its prompt was going";
            await ctx.emit(SessionInputSettled, { session: ref, operation, outcome: { status: "possibly-sent", reason } });
            const answer = startUnder(operation)?.answer;
            if (answer === undefined) throw new Error(`the start under operation "${operation}" was written and cannot be read back`);
            return answer;
          }
          const answer = starting(input, ctx, operation, digest);
          startsRunning.set(operation, { digest, answer });
          try {
            return await answer;
          } finally {
            startsRunning.delete(operation);
          }
        },
      }),
    );

    /** A start that nothing answered yet: the harness is asked for a session, once. */
    const starting = async (
      input: z.output<typeof sessionStart.input>,
      ctx: ActionContext,
      operation: string,
      digest: string,
    ): Promise<z.output<typeof sessionStart.output>> => {
      const control = controlFor(bindings, input.harness, "start");
      // A model or an effort the kind cannot apply is refused here, before anything is made.
      const instance = instanceOf(bindings, input.harness);
      requireLaunch(instance.id, instance.sides.control?.launch ?? { model: false, effort: [], modes: [] }, input);
      // The options block of another kind is refused here too: nothing is ignored.
      const blocks = requireOwnBlocks(instance.id, optionsOf(bindings, input.harness), blocksOf(input, SESSION_START_FIELDS));
      // A tool mode the installation cannot hold is refused here too, before any prompt.
      requireTools(instance.id, instance.sides.control?.tools, input.tools);
      const visible = visibleFor(input.harness, callsOf(input.visible));
      // Refused before a mark or a token is made: a start that asks for too much, or for a
      // box this machine cannot give, creates nothing.
      const rules = grantOfSession(ctx.caller, input.visible, visible);
      // A session asked to run in a worktree gets one made by the git module, and runs in it.
      const worktree = input.worktree === undefined ? undefined : await worktreeFor(ctx, input.harness, input.worktree, input.cwd);
      const cwd = worktree?.path ?? input.cwd;
      const launch = await launchFor(rules, cwd, input.harness);
      // The mode asked for, within the allow-list of the grant: what the grant adds is held too.
      const tools = toolsOfSession(input.tools, launch.tools);
      requireTools(instance.id, instance.sides.control?.tools, tools);
      // The mark is made in the run: a replay returns what the run returned, and the mark
      // is in the journal with the session it names.
      const mark = randomUUID();
      const token = tokenFor(mark, rules, ctx.caller);
      const servers = serversOf(visible.actions, mark, token);
      // A harness at its ceiling takes the start once one of its turns ends.
      const slot = await caps.admit(instance.id);
      // Written before the harness is asked: from here on a retry never asks it again.
      await ctx.emit(SessionStartReserved, { operation, digest, ...(cwd === undefined ? {} : { cwd }) }).catch((error: unknown) => {
        slot.release();
        throw error;
      });
      const asking = recording(mark, launch, ctx, () =>
        control.start({
          prompt: input.prompt,
          model: input.model,
          effort: input.effort,
          mode: input.mode,
          cwd,
          ...(Object.keys(blocks).length === 0 ? {} : { blocks }),
          visible,
          servers,
          env: { [TOKEN_ENV]: token },
          reverse: reverse.handlerFor(rules, starterOf(ctx.caller), ownToolPrefix(visible.actions)),
          ...launchOptions(launch, mark),
          ...(tools === undefined ? {} : { tools }),
          named: async (named) => {
            await ctx.emit(SessionStartNamed, { operation, session: sessionRef(named) });
          },
        }),
      );
      const { session: id, first, mode } = await asking.catch(async (error: unknown) => {
        slot.release();
        // Nothing reached the harness: the reservation is let go, and a retry asks again.
        if (!effectPossibleAfter(error)) {
          await ctx.emit(SessionStartUnsent, { operation, reason: error instanceof Error ? error.message : String(error) });
        }
        throw error;
      });
      slot.reached(sessionRef(id), first);
      // The harness named the session: only now is there a session at all. Its first turn
      // may be running already; the side keeps the signs of that turn for the first stream
      // of life, and that stream is the one followed here, so none of them is lost.
      const ref = sessionRef(id);
      const issued = sessionIds.issue(ctx.operationId);
      await ctx.emit(SessionStarted, {
        session: ref,
        id: issued,
        cwd,
        effort: input.effort,
        mode: mode ?? input.mode,
        options: Object.keys(blocks).length === 0 ? undefined : blocks,
        ...(input.tools === undefined || input.tools === "all" ? {} : { tools: input.tools }),
        ...(input.stuckAfter === undefined ? {} : { stuckAfter: input.stuckAfter }),
      });
      await ctx.emit(SessionMarked, { session: ref, mark });
      // The session has a name only now, so the input of its prompt is written once the harness took it; a start
      // without a prompt is written too, so a retry of it finds the session it made.
      await ctx.emit(SessionInputSending, { session: ref, operation, digest });
      if (first !== undefined) await ctx.emit(SessionInputSettled, { session: ref, operation, outcome: { status: "accepted", receipt: first } });
      follow(control, ref, id);
      return {
        session: issued,
        ref,
        ...(first === undefined ? {} : { receipt: first }),
        ...(worktree === undefined ? {} : { worktree: { id: worktree.id, path: worktree.path, branch: worktree.branch } }),
        operation,
      };
    };

    api.action(
      action(sessionResume, {
        // The harness takes the session on again: a resume that was cut off may have
        // happened, so it is not made again.
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        run: async (input, ctx) => {
          const { ref, id, control } = controlOf(input.session, "resume");
          const prompt = input.prompt;
          // A resume with a prompt begins a turn: a harness at its ceiling takes it once one of its turns ends.
          // The slot is taken before anything is decided of the session, which may change while it waits.
          // A resume without a prompt takes the session on and runs nothing, so it waits for nothing.
          const slot = prompt === undefined ? undefined : await caps.admit(id.harness, ref);
          try {
            // A resume that is given no `visible` takes the grant the session was last launched
            // with: the session is the same, and so are its tools, its box and its rights.
            const restored = input.visible === undefined ? lastLaunchOf(ref) : undefined;
            const requested = input.visible ?? restored?.request;
            const visible = visibleFor(id.harness, callsOf(requested));
            const rules = grantOfSession(ctx.caller, requested, visible);
            // A process that is still running keeps what it was born with: only a process that is
            // gone is launched again, and only then are its tools, box and servers asked for.
            const gone = (await control.state(id)) === "unknown";
            const launches = input.visible !== undefined || gone;
            // A process that is launched again counts its turns from 1: the records go on from the last.
            if (gone) restart(ref);
            // The directory the session was started in: a harness that loads a session by it needs the same one.
            const startedIn = restored?.cwd ?? startedOf(ref)?.cwd;
            const launch = launches ? await launchFor(rules, startedIn, id.harness) : {};
            // A process launched again keeps the tools the session was started with, within its grant.
            const tools = launches ? toolsOfSession(startedOf(ref)?.tools, launch.tools) : undefined;
            const mark = randomUUID();
            const token = tokenFor(mark, rules, ctx.caller);
            const servers = launches ? serversOf(visible.actions, mark, token) : undefined;
            // The session is named already: the pairing is written before the harness takes it
            // on, so the server it is given finds the session from its first list of tools.
            await ctx.emit(SessionMarked, { session: ref, mark });
            const started = startedOf(ref);
            const mode = started?.mode;
            // The session starts again with the model the harness named for it, not the alias it was asked for.
            const model = modelOf(ref);
            await recording(mark, launch, ctx, () =>
              control.resume(id, {
                ...(mode === undefined ? {} : { mode }),
                ...(model === undefined ? {} : { model }),
                ...blocksOfSession(started),
                ...(prompt === undefined ? {} : { prompt }),
                ...(launches && startedIn !== undefined ? { cwd: startedIn } : {}),
                ...(launches && requested !== undefined ? { visible } : {}),
                ...(servers === undefined ? {} : { servers }),
                env: { [TOKEN_ENV]: token },
                reverse: reverse.handlerFor(rules, starterOf(ctx.caller), ownToolPrefix(visible.actions)),
                ...launchOptions(launch, mark),
                ...(tools === undefined ? {} : { tools }),
              }),
            );
            slot?.reached(ref, { status: "started" });
            follow(control, ref, id);
            return { resumed: true };
          } catch (error) {
            slot?.release();
            throw error;
          }
        },
      }),
    );

    api.action(
      action(sessionSend, {
        // The message is delivered into the session: a send that was cut off may have
        // been delivered, so it is not made again.
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        run: async (input, ctx) => {
          const { ref, id, control } = controlOf(input.session, "send");
          // The slot of the harness is taken before anything is written of the send, so a send that waits
          // for one is not taken for possibly sent if the host stops while it waits.
          const sending = async (slot: Slot): Promise<DeliveryReceipt> => {
            try {
              const receipt = await control.send(id, input.message, input.into === undefined ? undefined : { into: input.into });
              slot.reached(ref, receipt);
              return receipt;
            } catch (error) {
              slot.release();
              throw error;
            }
          };
          // The turn is named as the records name it, not as the harness counts it in this process.
          const named = (receipt: DeliveryReceipt) => (receipt.turn === undefined ? receipt : { ...receipt, turn: numbered(ref, receipt.turn) });
          // A harness at its ceiling takes the message once one of its turns ends.
          if (input.operation === undefined) return { receipt: named(await sending(await caps.admit(id.harness, ref))) };

          const operation = input.operation;
          const digest = createHash("sha256").update(JSON.stringify([input.message, input.into ?? null])).digest("hex");
          const before = inputOf(ref, operation);
          if (before !== undefined) {
            if (before.digest !== digest) {
              throw new SessionRefusal("operation-conflict", `operation "${operation}" was a send of another message into this session`);
            }
            // What became of it is answered from the records; only a message that never went is sent again.
            if (before.outcome?.status === "accepted") return { receipt: before.outcome.receipt };
            if (before.outcome?.status !== "unsent") {
              throw new InputPossiblySent(id.harness, "send", before.outcome?.reason ?? "the send was cut off before its outcome was known");
            }
          }
          const slot = await caps.admit(id.harness, ref);
          await ctx.emit(SessionInputSending, { session: ref, operation, digest }).catch((error: unknown) => {
            slot.release();
            throw error;
          });
          const outcome = await outcomeOf(sending(slot).then(named));
          await ctx.emit(SessionInputSettled, { session: ref, operation, outcome });
          switch (outcome.status) {
            case "accepted":
              return { receipt: outcome.receipt };
            case "unsent":
              throw new InputNotSent(id.harness, "send", outcome.reason);
            case "possibly-sent":
              throw new InputPossiblySent(id.harness, "send", outcome.reason);
          }
        },
      }),
    );

    api.action(
      action(sessionInterrupt, {
        // The turn is interrupted once: an interrupt that was cut off may have happened,
        // so it is not made again.
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        run: async (input) => {
          // Refused before anything is attempted: niwa does not emulate an interrupt.
          const { ref, id, control } = controlOf(input.session, "interrupt");
          interrupting.add(ref);
          try {
            await control.interrupt(id);
          } catch (error) {
            interrupting.delete(ref);
            throw error;
          }
          return { interrupted: true };
        },
      }),
    );

    api.action(
      action(sessionEnd, {
        // Ending a session that ended already leaves it as it is: it may be made again.
        recovery: "repeat",
        effect: "write",
        world: "local",
        run: async (input, ctx) => {
          const ref = refOf(input.session);
          const id = sessionOf(ref);
          const over = api.journal?.()?.find({ type: SessionEnded.name, field: "session", equals: ref }).length ?? 0;
          if (over > 0) return { ended: false };
          const control = bindings.find((binding) => binding.instance.id === id.harness)?.control;
          // A turn it runs stops where the harness can stop one; a harness that cannot, or a session with no turn, is
          // not a reason to keep it.
          if (control !== undefined && instanceOf(bindings, id.harness).sides.control?.interrupt === true && (await control.state(id).catch(() => "unknown")) === "running") {
            interrupting.add(ref);
            await control.interrupt(id).catch(() => interrupting.delete(ref));
          }
          await ctx.emit(SessionEnded, { session: ref, reason: input.reason });
          // The stream of life the process ends with says nothing more: the end is written.
          ending.add(ref);
          await control?.close?.(id);
          return { ended: true };
        },
      }),
    );

    api.action(
      action(sessionOpenQuestions, {
        // A read of what waits changes nothing: it may be made again.
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: async (input, ctx) => {
          const journal = api.journal?.();
          if (journal === undefined) return { questions: [] };
          const session = sessionOfMark(input.mark);
          if (session === undefined) return { questions: [] };
          // The questions are the requests module's open requests addressed to the session, as
          // a non-native ask addresses them.
          const id = sessionOf(session);
          const { requests: open } = await ctx.step(requestOpen, {
            to: { kind: "session", harness: id.harness, id: id.native },
          });
          const questions: { request: string; schema: JsonSchemaValue }[] = [];
          for (const entry of open) {
            if ("kind" in entry) continue;
            questions.push({ request: entry.id, schema: valueSchemaOf(entry.input) });
          }
          return { questions };
        },
      }),
    );

    api.action(
      action(sessionAsk, {
        // The session is asked: an ask that was cut off may have reached the harness, so
        // it is not made again.
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        run: async (input, ctx) => {
          const { ref, id, control } = controlOf(input.session, "ask");
          const schema = z.fromJSONSchema(input.schema);
          const prompt = input.prompt;
          if (supports(instanceOf(bindings, id.harness), "control", "structuredOutput")) {
            // The answer is a turn of the session: a harness at its ceiling takes it once one of its turns ends.
            const slot = await caps.admit(id.harness, ref);
            const answer = await control.ask(id, { schema, prompt, ...blocksOfSession(startedOf(ref)) }).finally(() => slot.release());
            // The harness said the answer is structured; niwa checks it all the same.
            const parsed = schema.safeParse(answer.value);
            if (!parsed.success) {
              throw new ValidationError(`the answer of the session "${ref}" does not pass its schema`, parsed.error.issues);
            }
            return { value: parsed.data };
          }
          // The harness cannot answer natively: the question niwa asks of the session is a
          // request, and the answer comes back through `submit-answer`. The request waits, and
          // the wait survives a restart.
          const value = await askNonNative(ctx, {
            to: { kind: "session", harness: id.harness, id: id.native },
            prompt,
            schema,
          });
          return { value };
        },
      }),
    );
  });

  return Object.assign(made, { bind });
}

/** The sessions plugin: a plugin that also says what address a session's own client speaks as. */
export type SessionsPlugin = Plugin & { bind(fallback?: CallerBinding): CallerBinding };

/** What the manifest record holds. */
type BoxManifest = z.output<typeof SessionBoxManifest.schema>;

/** What a request asks for besides the niwa actions: its `tool:`, `write:` and `net:` rules are for the launch. */
function callsOf(input: VisibleActionsInput | undefined): VisibleActionsInput | undefined {
  if (input?.actions === undefined) return input;
  return { ...input, actions: input.actions.filter((spec) => !isLaunchRule(spec)) };
}

/**
 * The record of a box, with the names of its environment and none of the values: they hold the
 * session's token, of which the journal keeps only the MAC, and the keys of the provider.
 */
function manifestRecord(made: BoxRecord, mark: string): BoxManifest {
  const { env: _specEnv, ...spec } = made.spec;
  const { env, ...manifest } = made.manifest;
  return {
    mark,
    harness: made.harness,
    sandbox: made.sandbox,
    spec,
    env: Object.keys(env).map((name) => EnvNameSchema.parse(name)),
    manifest,
  };
}

/** The installations the plugin may read from and start sessions on, with their sides. */
function resolveBindings(options: SessionsOptions): HarnessBinding[] {
  const { harnesses } = options;
  if (harnesses instanceof HarnessInstanceRegistry) return harnesses.bindings();
  const bindings = [...(harnesses ?? [])];
  const seen = new Set<string>();
  for (const { instance } of bindings) {
    // Two bindings under one id would be one installation with two sets of sides.
    if (seen.has(instance.id)) throw new Error(`harness instance "${instance.id}" is bound twice`);
    seen.add(instance.id);
  }
  return bindings;
}

/** The options block a session was started with, as a control side is given it again. */
function blocksOfSession(started: { readonly options?: OptionBlocks } | undefined): { blocks?: OptionBlocks } {
  return started?.options === undefined ? {} : { blocks: started.options };
}

/** The options block the kind of a harness takes, when it declares one. */
function optionsOf(bindings: readonly HarnessBinding[], harness: string): KindOptions | undefined {
  return bindings.find((binding) => binding.instance.id === harness)?.options;
}

/** An ability of the control side, as an installation declares it. */
type ControlAbility = "start" | "resume" | "send" | "interrupt" | "ask";

/** The installation of a harness, as the bindings know it. */
function instanceOf(bindings: readonly HarnessBinding[], harness: string): Harness {
  const found = bindings.find((binding) => binding.instance.id === harness);
  if (found === undefined) throw new Error(`harness "${harness}" is not known`);
  return found.instance;
}

/**
 * The control side of a harness, once the installation has declared the ability.
 *
 * An undeclared ability is refused by name before anything is attempted. A declared one with no
 * code behind it is a wiring mistake, and is said as such.
 */
function controlFor(bindings: readonly HarnessBinding[], harness: string, ability: ControlAbility): SessionControl {
  const instance = instanceOf(bindings, harness);
  requireAbility(instance, "control", ability);
  const control = bindings.find((binding) => binding.instance.id === harness)?.control;
  if (control === undefined) throw new Error(`harness "${harness}" declares a control side but none is bound`);
  return control;
}

/**
 * The sessions the reading sides list, and the harnesses that could not be asked.
 *
 * A side without a reading side, or without the ability to list, is not asked and not blamed.
 * A side that fails is reported: the list is what is known, not proof that there is nothing more.
 */
/**
 * Make the worktree a session runs in, through the git module's action: the repository is the one
 * asked for, else the session's cwd, else the host's directory; the description is the one asked
 * for, else the harness's.
 */
async function worktreeFor(ctx: ActionContext, harness: string, option: WorktreeOption, cwd: string | undefined): Promise<Worktree> {
  const asked = option === true ? {} : option;
  return ctx.step(gitWorktreeCreate, {
    repo: asked.repo ?? cwd ?? process.cwd(),
    ...(asked.base === undefined ? {} : { base: asked.base }),
    description: asked.description ?? EntityDescription.parse(`a session of ${harness}`.slice(0, DESCRIPTION_MAX)),
  });
}

async function listFromSides(
  bindings: readonly HarnessBinding[],
  harness: string | undefined,
  cwd: string | undefined,
): Promise<{ listed: SessionInfo[]; unreadable: { harness: string; reason: string }[] }> {
  const listed: SessionInfo[] = [];
  const unreadable: { harness: string; reason: string }[] = [];
  for (const binding of bindings) {
    if (harness !== undefined && binding.instance.id !== harness) continue;
    if (binding.reading === undefined || !supports(binding.instance, "reading", "list")) continue;
    try {
      for await (const info of binding.reading.list(cwd === undefined ? undefined : { cwd })) listed.push(info);
    } catch (error) {
      unreadable.push({
        harness: binding.instance.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { listed, unreadable };
}

export { SessionCatalog } from "./catalog.ts";
export { SessionRefusal } from "./refusal.ts";
export { REVERSE_QUESTION, REVERSE_TYPES, ReverseIdSchema, SessionReverseAnswered, SessionReverseAsked, SessionReverseCancelled } from "./reverse.ts";
export type { ReverseId } from "./reverse.ts";
export { isLaunchRule, launchOf } from "./box.ts";
export type { GrantLaunch, LaunchPlan } from "./box.ts";
export type { Belonging, SessionEntry } from "./catalog.ts";
export { NiwaSessionIdSchema, SessionRefSchema, sessionOf, sessionRef } from "./identity.ts";
export type { NiwaSessionId, SessionRef } from "./identity.ts";
export { lifeOf } from "./life.ts";
export type { LifeState } from "./life.ts";
export {
  SESSION_TYPES,
  BelongingSource,
  SessionCompacted,
  SessionActivity,
  SessionAdvisor,
  SessionBelongs,
  SessionBoxManifest,
  SessionEnded,
  SessionMarked,
  SessionModel,
  SessionStarted,
  SessionTurnEnded,
  SessionTurnStarted,
  SessionUnknownVariant,
  sameAddress,
  SESSION_SEND,
  DeliveryReceiptSchema,
} from "./records.ts";
export type { DeliveryReceipt, SessionSendInput, SessionSendOutput } from "./records.ts";
export {
  SESSION_QUESTION,
  SUBMIT_ANSWER_ACTION,
  askNonNative,
  questionText,
  submitAnswerAction,
} from "./ask.ts";
export { PromptInputSchema, promptFrom } from "./prompt.ts";
export { VisibleActionsInputSchema, visibleActionsOf } from "./visible.ts";
export {
  sessionAsk,
  sessionBelong,
  sessionGet,
  sessionEnd,
  sessionInterrupt,
  sessionList,
  sessionOpenQuestions,
  sessionRead,
  sessionResume,
  harnessGet,
  harnessList,
  sessionRunning,
  sessionSearch,
  sessionSend,
  sessionStart,
} from "./actions.ts";

export {
  HARNESS_DISCOVER_ACTION,
  HarnessDiscoverOutputSchema,
  HarnessProposed,
  harnessDiscover,
  harnessDiscovery,
  proposalIdOf,
} from "./discover.ts";
export type { HarnessDiscoveryOptions, HarnessDiscoverOutput } from "./discover.ts";
export {
  HARNESS_CONFIRM_QUESTION,
  HarnessConfirmAnswerSchema,
  HarnessConfirmed,
  harnessConfirm,
} from "./confirm.ts";
export type { HarnessConfirmAnswer, HarnessConfirmOptions } from "./confirm.ts";
export { harnessSupport, harnessSupports } from "./support.ts";
export {
  Compacted,
  InsertReportOutputSchema,
  NestedSpawned,
  OpenedByHand,
  PERMISSION_QUESTION,
  PermissionAsked,
  SessionEndedByHarness,
  insertPlugin,
} from "./insert-plugin.ts";
export type { InsertPluginOptions, InsertReportOutput } from "./insert-plugin.ts";
export { PermissionIdSchema, PermissionRouter, permissionId } from "./insert-routing.ts";
export type { PermissionId } from "./insert-routing.ts";
