/**
 * Reads the OpenCode v2 transcript from SQLite without starting OpenCode. A host that already
 * runs OpenCode can explicitly give its read endpoint as `server`. Both transports use the same
 * mapping of messages and nested sessions.
 *
 * A locator is `opencode:v1:<message>:<part>`: the 0-based place of the message in the session's
 * full ordered message list, and the 0-based place of the record among that message's mapped
 * records — an assistant message of a text and a tool yields part 0 (the text), part 1 (the call)
 * and part 2 (the result). A session spawned inside this one sits where it was created: after the
 * last message that existed then, as a part of its own beyond that message's own records; a child
 * created before the first message sits at message -1. v2's messages are flat, and whole messages
 * do not grow, so a message's parts are counted as they stand at the read — only the tail of a
 * running session is still being written, and a reader is not to move past an incomplete record.
 * The one place that can move is a child anchored at the message that is that growing tail: its
 * parts are counted as they stand, and the count grows with the message. Such a child is marked
 * incomplete like the tail it sits in, and its place settles when the message completes.
 *
 * What v2's messages map to: a user message is a `user` record (its file attachments of an image
 * kind as image marks); an assistant message's `text` parts are `assistant` records, its
 * `reasoning` parts are `thinking` records, and its `tool` parts are a `tool-call` and, once the
 * tool has answered, the `tool-result` after it (an image block of the answer is an image mark).
 * A `compaction` message is a `compaction` record with the summary it wrote. A message type the
 * common model has no kind for — `system`, `synthetic`, `skill`, `shell`, the switched marks — is
 * an `unknown` record with the message kept whole; an `idle` message, the harness's own note that
 * a turn ended, is bookkeeping and maps to no record at all. An assistant message of the tail
 * with no completion time of its own is the half-written line: its records are marked incomplete,
 * and so is everything after them.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";
import { ClientError, OpenCode } from "@opencode/client";
import type {
  OpenCodeClient,
  SessionMessageInfo as WireMessage,
} from "@opencode/client";

import { optionalJsonOf, timestamp } from "@niwa-labs/core";
import {
  EMPTY,
  HarnessIdSchema,
  LocatorSchema,
  NOT_SCANNED,
  NativeSessionIdSchema,
  failedCoverage,
  modelName,
  takeImages,
  unavailableCoverage,
} from "@niwa-labs/harness";
import type {
  Coverage,
  HarnessId,
  ImageMark,
  Locator,
  SessionFilter,
  SessionId,
  SessionInfo,
  SessionReading,
  SessionRecord,
} from "@niwa-labs/harness";

import { HistoryUnavailable, OpenCodeHistory } from "./history.ts";
import { authOf, installationHome, storageEnvOf } from "./server.ts";
import { opencodeToolShape } from "./tools.ts";

/** A host's existing server, used only when explicitly configured. */
export interface OpenCodeServerEndpoint {
  readonly url: string;
  readonly password: string;
}

export interface OpenCodeReadingOptions {
  /** The id of the installation this side serves. */
  readonly harness: HarnessId;
  /**
   * The installation's state directory, ending in `opencode`. The default is
   * `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`.
   */
  readonly home?: string;
  /** Installation environment. An explicit `home` takes precedence over `XDG_DATA_HOME`. */
  readonly env?: Readonly<Record<string, string>>;
  /** An existing server to read through. */
  readonly server?: OpenCodeServerEndpoint;
  /** How long one HTTP call waits for its answer, in milliseconds. */
  readonly callTimeoutMs?: number;
}

/** A record before the reading side has put its locator in. */
type Unlocated = SessionRecord extends infer R ? (R extends unknown ? Omit<R, "locator"> : never) : never;

/** The place of a record in its session. */
interface Position {
  readonly message: number;
  readonly part: number;
}

interface Item {
  readonly at: Position;
  readonly record: Unlocated;
}

/** A session as the server holds it: its messages in order, and the sessions spawned inside it. */
export interface LoadedSession {
  readonly messages: readonly WireMessage[];
  readonly children: ReadonlyArray<{ readonly native: string; readonly created: number }>;
}

const LOCATOR = /^opencode:v1:(-?\d+):(\d+)$/;
const DEFAULT_CALL_TIMEOUT_MS = 180_000;
/** How many sessions or messages one page asks the server for. */
const PAGE_LIMIT = 100;

function encode(at: Position): Locator {
  return LocatorSchema.parse(`opencode:v1:${at.message}:${at.part}`);
}

function decode(locator: Locator): Position {
  const match = LOCATOR.exec(locator);
  if (match === null) throw new Error(`opencode: ${locator} is not a locator of this side`);
  return { message: Number(match[1]), part: Number(match[2]) };
}

function compare(a: Position, b: Position): number {
  return a.message - b.message || a.part - b.part;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The HTTP status an error answered with, when it answered with one. */
function statusOf(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as Error & { readonly cause?: unknown }).cause;
  if (cause !== null && typeof cause === "object" && "status" in cause) {
    const status = (cause as { readonly status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/**
 * Whether an error is the server saying there is no such session: the declared error of the route,
 * or the bare 404 of a server that does not declare it.
 */
function isNoSuchSession(error: unknown): boolean {
  return error instanceof Error && (error.name === "SessionNotFoundError" || statusOf(error) === 404);
}

/** Whether an error is no server being reached at all, however deep the client wrapped it. */
function isUnreachable(error: unknown): boolean {
  return error instanceof ClientError && error.reason === "Transport";
}

// -- the mapping ---------------------------------------------------------------

/** Whether an image stands in a file attachment or a block of a tool's answer. */
function isImage(value: { readonly mime?: string }): boolean {
  return value.mime?.startsWith("image/") ?? false;
}

/**
 * What one message says, as common records without their locators. `isLast` names the last
 * message of the session: only its tail can still be at work, and only an assistant message that
 * has no completion time of its own is the half-written line.
 */
export function recordsOfMessage(message: WireMessage, isLast: boolean): Unlocated[] {
  const running = isLast && message.type === "assistant" && message.time.completed === undefined;
  switch (message.type) {
    case "user": {
      // The text is what the person typed; the images are the attachments of an image kind, where
      // the message keeps them (a mention names the place in the text, else they stand at its end).
      const images: ImageMark[] = [];
      for (const file of message.files ?? []) {
        if (!isImage(file)) continue;
        images.push({ at: file.mention?.start ?? message.text.length, mime: file.mime });
      }
      return [
        {
          kind: "user",
          text: message.text,
          ...(images.length === 0 ? {} : { images }),
          at: message.time.created,
          incomplete: false,
        },
      ];
    }
    case "assistant": {
      const model = modelName(`${message.model.providerID}/${message.model.id}`);
      const records: Unlocated[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          records.push({ kind: "assistant", text: part.text, model, at: message.time.created, incomplete: running });
        } else if (part.type === "reasoning") {
          records.push({
            kind: "thinking",
            text: part.text,
            redacted: false,
            at: part.time?.created ?? message.time.created,
            incomplete: running,
          });
        } else {
          const state = part.state;
          const atWork = state.status === "streaming" || state.status === "running";
          records.push({
            kind: "tool-call",
            callId: part.id,
            name: part.name,
            ...opencodeToolShape(part.name, state.input),
            input: optionalJsonOf(state.input),
            at: part.time.created,
            // A call left at work in an older message was abandoned: only the last message can
            // still be running a tool, and a call of the tail holds the reader back.
            incomplete: running || (isLast && atWork),
          });
          if (atWork) continue;
          // The tool has answered: its blocks are the result, its image blocks taken out as marks.
          const blocks = state.content ?? [];
          const { rest, images } = takeImages(blocks, (block) =>
            block.type === "file" && isImage(block) ? { mime: block.mime } : undefined,
          );
          records.push({
            kind: "tool-result",
            callId: part.id,
            name: part.name,
            output: optionalJsonOf(rest),
            ok: state.status === "completed",
            ...(images.length === 0 ? {} : { images }),
            at: part.time.completed ?? part.time.created,
            incomplete: running,
          });
        }
      }
      return records;
    }
    case "compaction": {
      // A compaction that failed wrote no summary: the message is kept whole as it stands.
      if (message.status === "failed") break;
      return [{ kind: "compaction", summary: message.summary, at: message.time.created, incomplete: message.status === "running" }];
    }
    case "idle":
      // The harness's own note that a turn ended: bookkeeping, not conversation.
      return [];
    default:
      // A message type the common model has no kind for, or one this client does not know: kept
      // whole, which is what an unknown record is.
      break;
  }
  return [{ kind: "unknown", raw: message, at: message.time.created, incomplete: false }];
}

/** Where the sessions spawned inside a session sit: after the last message that existed when each was created. */
function nestedItems(harness: HarnessId, loaded: LoadedSession): Item[] {
  const { messages, children } = loaded;
  if (children.length === 0) return [];
  const anchorOf = (created: number): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const found = messages[index];
      if (found !== undefined && found.time.created <= created) return index;
    }
    return -1;
  };
  const sorted = [...children].sort((a, b) => a.created - b.created || a.native.localeCompare(b.native));
  const taken = new Map<number, number>();
  return sorted.map((child) => {
    const anchor = anchorOf(child.created);
    const base = anchor === -1 ? 0 : recordsOfMessage(messages[anchor]!, anchor === messages.length - 1).length;
    const index = taken.get(anchor) ?? 0;
    taken.set(anchor, index + 1);
    return {
      at: { message: anchor, part: base + index },
      record: {
        kind: "nested",
        child: { harness, native: NativeSessionIdSchema.parse(child.native) },
        at: child.created,
        incomplete: false,
      },
    };
  });
}

/**
 * The records of a session in the order they sit, with where each is. Only what follows `after`
 * is given. From the first record that is not whole on, nothing is: a reader does not move past a
 * half-written line — a child anchored past the line is as incomplete as the line it sits in.
 */
export function* itemsOf(harness: HarnessId, loaded: LoadedSession, after: Position | undefined): Generator<Item> {
  const given = (at: Position): boolean => after === undefined || compare(at, after) > 0;
  // A record past the half-written line is as incomplete as the line is — a child anchored there
  // included: the reader is not to move past what is still being written.
  const marked = (item: Item): Item => (tail ? { ...item, record: { ...item.record, incomplete: true } } : item);
  // The children in the order they sit — the messages anchor them monotonically — drawn as the
  // walk reaches each anchor.
  const nested = nestedItems(harness, loaded)[Symbol.iterator]();
  let ahead = nested.next();
  let tail = false;
  // Children created before the first message sit at message -1, ahead of everything.
  for (; !ahead.done && ahead.value.at.message === -1; ahead = nested.next()) {
    if (given(ahead.value.at)) yield marked(ahead.value);
  }
  const isLast = loaded.messages.length - 1;
  for (const [place, message] of loaded.messages.entries()) {
    for (const [part, record] of recordsOfMessage(message, place === isLast).entries()) {
      tail ||= record.incomplete;
      const at = { message: place, part };
      if (!given(at)) continue;
      yield { at, record: tail ? { ...record, incomplete: true } : record };
    }
    for (; !ahead.done && ahead.value.at.message === place; ahead = nested.next()) {
      if (given(ahead.value.at)) yield marked(ahead.value);
    }
  }
  for (; !ahead.done; ahead = nested.next()) {
    if (given(ahead.value.at)) yield marked(ahead.value);
  }
}

/** What `raw` gives back: the server's own JSON of a message, or of the session that was spawned. */
const RawRecordSchema = z.looseObject({ id: z.string().min(1) });

/** A read-only history transport for OpenCode. */
export class OpenCodeReading implements SessionReading {
  readonly #harness: HarnessId;
  readonly #transport: OpenCodeClient | OpenCodeHistory;
  readonly #callTimeoutMs: number;

  constructor(options: OpenCodeReadingOptions) {
    this.#harness = HarnessIdSchema.parse(options.harness);
    this.#callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    if (options.server !== undefined) {
      this.#transport = OpenCode.make({ baseUrl: options.server.url, headers: authOf(options.server.password) });
    } else {
      const data = options.env?.["XDG_DATA_HOME"] ?? process.env["XDG_DATA_HOME"];
      const userHome = options.env?.[process.platform === "win32" ? "USERPROFILE" : "HOME"] || homedir();
      const home = installationHome(options.home ?? resolve(data || join(userHome, ".local", "share"), "opencode"));
      const storage = storageEnvOf(options.env);
      this.#transport = new OpenCodeHistory(home, storage["OPENCODE_DB"] ?? "opencode.db");
    }
  }

  readonly rawSchema = RawRecordSchema;

  /** The options every HTTP call takes. */
  #callOptions(): OpenCode.RequestOptions {
    return { signal: AbortSignal.timeout(this.#callTimeoutMs) };
  }

  async *#sessions(filter?: SessionFilter): AsyncIterable<{
    id: string; title: string | undefined; directory: string; created: number; updated: number;
  }> {
    const transport = this.#transport;
    if (transport instanceof OpenCodeHistory) {
      for (const row of transport.list(filter?.cwd, filter?.since)) {
        yield { id: row.id, title: row.title ?? undefined, directory: row.directory, created: row.time_created, updated: row.time_updated };
      }
      return;
    }
    let cursor: string | undefined;
    do {
      const page = await transport.session.list(
        {
          limit: PAGE_LIMIT,
          ...(filter?.cwd !== undefined ? { directory: filter.cwd } : {}),
          ...(cursor === undefined ? {} : { cursor }),
        },
        this.#callOptions(),
      );
      for (const session of page.data) {
        yield {
          id: session.id,
          title: session.title,
          directory: session.location.directory,
          created: session.time.created,
          updated: session.time.updated,
        };
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor !== undefined);
  }

  async *list(filter?: SessionFilter): AsyncIterable<SessionInfo> {
    try {
      const wanted = filter?.natives !== undefined ? new Set(filter.natives) : undefined;
      for await (const session of this.#sessions(filter)) {
        if (wanted !== undefined && !wanted.has(session.id)) continue;
        if (filter?.since !== undefined && session.updated < filter.since) continue;
        const title = session.title?.replace(/\s+/g, " ").trim();
        yield {
          id: { harness: this.#harness, native: NativeSessionIdSchema.parse(session.id) },
          ...(title === undefined || title === "" ? {} : { title }),
          cwd: session.directory,
          startedAt: timestamp(session.created),
          updatedAt: timestamp(session.updated),
        };
      }
    } catch {
      // A listing that cannot be read ends there; the reading side never crashes the caller.
    }
  }

  /** Records of a session, after `from` when given. */
  async *read(id: SessionId, from?: Locator): AsyncIterable<SessionRecord> {
    const after = from === undefined ? undefined : decode(from);
    try {
      const loaded = await this.#load(id);
      if (loaded === undefined) return;
      for (const { at, record } of itemsOf(this.#harness, loaded, after)) {
        yield { ...record, locator: encode(at) } as SessionRecord;
      }
    } catch {
      // A session that cannot be read yields what it has; the reading side never crashes the caller.
    }
  }

  /** The server's own JSON at a locator: the message whole, or the session that was spawned. */
  async raw(id: SessionId, locator: Locator): Promise<unknown> {
    const at = decode(locator);
    const loaded = await this.#load(id);
    if (loaded === undefined) throw new Error(`opencode: no session ${id.native}`);
    const message = at.message >= 0 ? loaded.messages[at.message] : undefined;
    if (message !== undefined) {
      const isLast = at.message === loaded.messages.length - 1;
      if (at.part < recordsOfMessage(message, isLast).length) return message;
    }
    // A part at or past a message's own records is a session spawned inside, anchored there.
    const nested = nestedItems(this.#harness, loaded).find((item) => compare(item.at, at) === 0);
    if (nested?.record.kind === "nested") {
      const child = nested.record.child.native;
      return this.#transport instanceof OpenCodeHistory
        ? this.#transport.rawSession(child)
        : this.#transport.session.get({ sessionID: child }, this.#callOptions());
    }
    throw new Error(`opencode: no record at ${locator} in session ${id.native}`);
  }

  /**
   * Coverage and reading use the same projection, including incomplete records and nested
   * sessions. A missing store or session is unavailable. An error reading it is a failed scan.
   */
  async coverage(id: SessionId, from?: Locator): Promise<Coverage> {
    try {
      const after = from === undefined ? undefined : decode(from);
      const loaded = await this.#load(id);
      if (loaded === undefined) return unavailableCoverage(`opencode: no session ${id.native}`);
      for (const _ of itemsOf(this.#harness, loaded, after)) return NOT_SCANNED;
      return EMPTY;
    } catch (error) {
      if (error instanceof HistoryUnavailable || isUnreachable(error)) return unavailableCoverage(`opencode: ${messageOf(error)}`);
      return failedCoverage(`opencode: session ${id.native} could not be scanned: ${messageOf(error)}`);
    }
  }

  /**
   * A session as the server holds it: its existence checked, its messages in order, and the
   * sessions spawned inside it. `undefined` when the server knows no such session. Every call
   * takes its own timeout: a session of many pages is not cut off by the time of its first.
   */
  async #load(id: SessionId): Promise<LoadedSession | undefined> {
    const client = this.#transport;
    if (client instanceof OpenCodeHistory) return client.load(id.native);
    try {
      await client.session.get({ sessionID: id.native }, this.#callOptions());
    } catch (error) {
      if (isNoSuchSession(error)) return undefined;
      throw error;
    }
    const messages: WireMessage[] = [];
    let cursor: string | undefined;
    for (;;) {
      // The first page names the order; every page after it follows the cursor, which carries the
      // order of its own — the server refuses a cursor combined with `order`. And the message
      // route always offers a next cursor, even past the last message, so a page that came short
      // is the only "no more" it says.
      const page = await client.message.list(
        { sessionID: id.native, limit: PAGE_LIMIT, ...(cursor === undefined ? { order: "asc" as const } : { cursor }) },
        this.#callOptions(),
      );
      messages.push(...page.data);
      if (page.data.length < PAGE_LIMIT) break;
      cursor = page.cursor.next ?? undefined;
      if (cursor === undefined) break;
    }
    const children: Array<{ native: string; created: number }> = [];
    cursor = undefined;
    for (;;) {
      const page = await client.session.list({ parentID: id.native, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) }, this.#callOptions());
      for (const session of page.data) children.push({ native: session.id, created: session.time.created });
      cursor = page.cursor.next ?? undefined;
      if (cursor === undefined) break;
    }
    return { messages, children };
  }
}
