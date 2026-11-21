/**
 * The pi insert: turns the events pi hands to an extension into niwa's insert events
 * and passes them on.
 *
 * It does not import pi's packages: the shapes of the events it reads are declared here, so it is
 * tested without pi. Pi has no way to answer a prompt from outside, so this side carries no
 * permission answers.
 */

import { harnessId, sessionId } from "@niwa-labs/harness";
import type { HarnessInsert, InsertEvent, SessionId } from "@niwa-labs/harness";

/** How an event reaches niwa: the action "insert.report". */
export type InsertReporter = (event: InsertEvent) => Promise<void>;

/**
 * How the pi insert is set up.
 *
 * The reporter says how the events reach niwa; without it the insert has nothing to report to,
 * and a kind that names no reporter does not serve the insert side at all.
 */
export interface PiInsertOptions {
  /** How events reach niwa. */
  readonly report: InsertReporter;
  /**
   * The session was started by niwa, so it is not taken for one opened by hand.
   *
   * Default: false, so a session the owner opened is reported.
   */
  readonly owned?: boolean;
  /**
   * The id of the installation the sessions belong to: the one the reading and the control side use.
   *
   * Default: `pi`.
   */
  readonly harness?: string;
}

/** The id of the harness when no installation is named: pi's sessions are pi's own. */
export const PI_HARNESS = "pi";

/**
 * The environment variable that names the installation a pi process belongs to, so the extension
 * inside it reports the sessions under the same id the reading and the control side give them.
 */
export const PI_INSTANCE_ENV = "NIWA_PI_INSTANCE";

/** The session of pi that an event is about, of the installation `harness` names. */
export function piSession(native: string, harness: string = PI_HARNESS): SessionId {
  return sessionId(harnessId(harness), native);
}

/** Pi's "session_start", as far as the insert reads it. */
export interface PiSessionStart {
  readonly reason: "startup" | "reload" | "new" | "resume" | "fork";
}

/** Pi's "session_compact", as far as the insert reads it. */
export interface PiSessionCompact {
  readonly compactionEntry: { readonly summary: string };
}

/** Pi's "session_shutdown": pi leaves the session, to quit or for another one; a reload stays in it. */
export interface PiSessionShutdown {
  readonly reason: "quit" | "reload" | "new" | "resume" | "fork";
}

/** Pi's "ui_prompt_start": a blocking question pi asks the person. */
export interface PiUiPromptStart {
  readonly kind: "select" | "confirm" | "input" | "editor" | "custom";
  readonly title?: string;
}

/** The session pi is in, as the extension context tells it. */
export interface PiSessionInfo {
  readonly id: string;
  readonly cwd: string;
}

/** The prompts that ask the person to allow or refuse something. */
const QUESTION_KINDS: ReadonlySet<PiUiPromptStart["kind"]> = new Set(["select", "confirm"]);

export class PiInsert implements HarnessInsert {
  private readonly readers = new Set<(event: InsertEvent) => void>();
  private readonly report: InsertReporter;
  private readonly owned: boolean;
  private readonly harness: string;
  private prompts = 0;

  /** The insert is set up with how its events reach niwa and whether it owns the session. */
  constructor(options: PiInsertOptions) {
    this.report = options.report;
    this.owned = options.owned ?? false;
    this.harness = options.harness ?? PI_HARNESS;
  }

  /** The events from the moment of the call, as they happen. */
  events(): AsyncIterable<InsertEvent> {
    const readers = this.readers;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: InsertEvent[] = [];
        let wake: (() => void) | undefined;
        const reader = (event: InsertEvent) => {
          queue.push(event);
          wake?.();
        };
        readers.add(reader);
        try {
          for (;;) {
            const event = queue.shift();
            if (event !== undefined) yield event;
            else await new Promise<void>((resolve) => (wake = resolve));
          }
        } finally {
          readers.delete(reader);
        }
      },
    };
  }

  /** A session the owner started or opened anew; a reload, a resume or a fork continues one. */
  async onSessionStart(event: PiSessionStart, session: PiSessionInfo): Promise<void> {
    if (this.owned || (event.reason !== "startup" && event.reason !== "new")) return;
    await this.emit({
      kind: "opened-by-hand",
      session: piSession(session.id, this.harness),
      cwd: session.cwd,
      at: Date.now(),
    });
  }

  async onSessionCompact(event: PiSessionCompact, session: PiSessionInfo): Promise<void> {
    await this.emit({
      kind: "compacted",
      session: piSession(session.id, this.harness),
      summary: event.compactionEntry.summary,
      at: Date.now(),
    });
  }

  /** Pi left the session: it quit, or went on in another one. A reload goes on in the same session. */
  async onSessionShutdown(event: PiSessionShutdown, session: PiSessionInfo): Promise<void> {
    if (event.reason === "reload") return;
    await this.emit({ kind: "session-ended", session: piSession(session.id), reason: event.reason, at: Date.now() });
  }

  /** Pi has no id for a prompt, so the insert numbers them within the session. */
  async onUiPromptStart(event: PiUiPromptStart, session: PiSessionInfo): Promise<void> {
    if (!QUESTION_KINDS.has(event.kind)) return;
    this.prompts += 1;
    await this.emit({
      kind: "permission-asked",
      session: piSession(session.id, this.harness),
      requestId: `${session.id}:prompt:${this.prompts}`,
      tool: `ui:${event.kind}`,
      ...(event.title === undefined ? {} : { detail: event.title }),
      at: Date.now(),
    });
  }

  private async emit(event: InsertEvent): Promise<void> {
    for (const reader of this.readers) reader(event);
    await this.report(event);
  }
}
