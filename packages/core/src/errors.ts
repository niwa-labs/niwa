/**
 * The core errors of niwa.
 *
 * Every error carries its identity twice: `name` (the class name) and `code` (the same string),
 * because the server sends `code` to the client. An error about a named thing takes that thing
 * first (`new UnknownType(type)`), an error about a condition takes the message first
 * (`new WriterBusy(message)`); the message belongs to the caller, the class supplies a default.
 */

import type { ActionName, RecordId, RecordTypeName } from "./types.ts";

/** Another living process holds the journal: a dead one is taken over, a living one is reported. */
export class WriterBusy extends Error {
  override name = "WriterBusy";
  readonly code = "WriterBusy";
  /** The pid and the epoch of the living writer, when known. */
  readonly pid?: number;
  readonly epoch?: number;

  constructor(message = "another living process holds the journal", details?: { pid?: number; epoch?: number }) {
    super(message);
    this.pid = details?.pid;
    this.epoch = details?.epoch;
  }
}

/** The journal was taken over: this process must not write anything, and must not retry. */
export class LostOwnership extends Error {
  override name = "LostOwnership";
  readonly code = "LostOwnership";
  /** The instance id this writer had registered, and the epoch the new writer holds, when known. */
  readonly instance?: string;
  readonly epoch?: number;

  constructor(message = "this writer was taken over by another writer", details?: { instance?: string; epoch?: number }) {
    super(message);
    this.instance = details?.instance;
    this.epoch = details?.epoch;
  }
}

/** The same record id was written with different content: nothing was written. */
export class IntegrityError extends Error {
  override name = "IntegrityError";
  readonly code = "IntegrityError";
  /** The id that was written twice with different content. */
  readonly id: RecordId;
  /** The fields that differ from the committed record. */
  readonly differing?: readonly string[];

  constructor(
    id: RecordId,
    message?: string,
    details?: { differing?: readonly string[] },
  ) {
    super(message ?? `record "${id}" already exists with different content`);
    this.id = id;
    this.differing = details?.differing;
  }
}

/**
 * An error the caller of an action catches, instead of the step failing with it.
 *
 * The core does not record a failed outcome for such an error: it belongs to the code that
 * called the action, and that code decides what happens next. The call may be made again, so
 * the error is thrown again and the caller catches it again.
 */
export class CatchableError extends Error {
  override name = "CatchableError";
  readonly code: string = "CatchableError";
}

/**
 * An action failed before anything it does left it: the other side never got the request, or
 * refused it by name. A call that ends with this did nothing, so it may be made again.
 *
 * Any other error an action throws leaves the effect possible, because the action may have got
 * part of the way. An action that knows it sent nothing says so by throwing this, or any error that
 * carries `effectPossible: false`.
 */
export class NotSent extends Error {
  override name = "NotSent";
  readonly code: string = "NotSent";
  readonly effectPossible = false;
}

/** May the call that ended with this error have had an effect? Only an error that says it had none had none. */
export function effectPossibleAfter(error: unknown): boolean {
  return typeof error !== "object" || error === null || (error as { effectPossible?: unknown }).effectPossible !== false;
}

/**
 * The step was cancelled: the work it stood for was given up, by the code that made it or by the
 * owner. The caller catches it: a cancelled step pauses nothing, and a replay throws it again.
 */
export class StepCancelled extends CatchableError {
  override name = "StepCancelled";
  override readonly code: string = "StepCancelled";
  /** The key of the step that was cancelled. */
  readonly key: string;
  /** Why it was cancelled. */
  readonly reason: string;

  constructor(key: string, reason: string) {
    super(`step ${key} was cancelled: ${reason}`);
    this.key = key;
    this.reason = reason;
  }
}

/**
 * A handler waits for a trigger whose record type no installed plugin declares: it could never
 * fire. The host refuses to serve instead of waiting forever.
 */
export class MissingProvider extends Error {
  override name = "MissingProvider";
  readonly code = "MissingProvider";
  /** The plugin that registered the handler. */
  readonly plugin: string;
  /** The handler that would never fire. */
  readonly handler: string;
  /** The record type nobody declares. */
  readonly type: RecordTypeName;

  /**
   * `use` says what the handler does with the type: it waits for it as a trigger, or it needs it
   * for its own work (a durable sleep needs the timers), and then it cannot do that work.
   */
  constructor(plugin: string, handler: string, type: RecordTypeName, provider?: string, use: "trigger" | "needs" = "trigger") {
    const missing = provider === undefined ? "no installed plugin declares it" : `the "${provider}" plugin is not installed`;
    super(
      use === "trigger"
        ? `plugin "${plugin}" handles the trigger "${handler}" of "${type}", but ${missing}: it would never fire`
        : `plugin "${plugin}" has the handler "${handler}", which needs "${type}", but ${missing}: its work would fail or wait for ever`,
    );
    this.plugin = plugin;
    this.handler = handler;
    this.type = type;
  }
}

/**
 * A plugin offers at a point (`api.offer`) whose reader is not installed: what it offers would be
 * lost. The host refuses to serve instead.
 */
export class MissingReader extends Error {
  override name = "MissingReader";
  readonly code = "MissingReader";
  /** The plugin that offers. */
  readonly plugin: string;
  /** The point it offers at. */
  readonly point: string;
  /** The plugin that reads the point. */
  readonly reader: string;

  constructor(plugin: string, point: string, reader: string) {
    super(`plugin "${plugin}" offers "${point}", which the "${reader}" plugin reads, but it is not installed: install it`);
    this.plugin = plugin;
    this.point = point;
    this.reader = reader;
  }
}

/** The record type was not declared: nothing was written. */
export class UnknownType extends Error {
  override name = "UnknownType";
  readonly code = "UnknownType";
  /** The type that was not declared. */
  readonly type: RecordTypeName;

  constructor(type: RecordTypeName, message?: string) {
    super(message ?? `unknown record type "${type}"`);
    this.type = type;
  }
}

/** The action was not registered: nothing was called. */
export class UnknownAction extends Error {
  override name = "UnknownAction";
  readonly code = "UnknownAction";
  /** The action that was not registered. */
  readonly action: ActionName;

  constructor(action: ActionName, message?: string) {
    super(message ?? `unknown action "${action}"`);
    this.action = action;
  }
}

/**
 * A schema check failed: the value was not accepted.
 *
 * `issues` stay untyped on purpose: the core does not decide what the issues of a schema look
 * like, and the schema that failed is the one that knows.
 */
export class ValidationError extends Error {
  override name = "ValidationError";
  readonly code = "ValidationError";
  readonly issues: unknown;

  constructor(message = "schema check failed", issues?: unknown) {
    super(message);
    this.issues = issues;
  }
}

/**
 * A plugin cannot be given without one of its handlers: it has no handler of that name, or the
 * handler is its last one and a plugin with nothing left to run is not a replacement but an
 * unload.
 */
export class CannotRemoveHandler extends Error {
  override name = "CannotRemoveHandler";
  readonly code = "CannotRemoveHandler";
  /** The plugin and the handler that was asked for. */
  readonly plugin: string;
  readonly handler: string;
  readonly reason: "unknown" | "last";

  constructor(plugin: string, handler: string, reason: "unknown" | "last") {
    super(
      reason === "unknown"
        ? `plugin "${plugin}" has no handler "${handler}"`
        : `"${handler}" is the last handler of plugin "${plugin}": unload the plugin instead of retiring it`,
    );
    this.plugin = plugin;
    this.handler = handler;
    this.reason = reason;
  }
}

/**
 * `use` stopped at a plugin that could not be installed.
 *
 * The plugins before it stay installed: each install is complete on its own, and one that replaced
 * an earlier plugin cannot be taken back without losing the plugin it replaced. The plugins after
 * it were not tried.
 */
export class PluginInstallFailed extends Error {
  override name = "PluginInstallFailed";
  readonly code = "PluginInstallFailed";
  /** The plugin that failed. */
  readonly plugin: string;
  /** The plugins of this call that were installed, in order. */
  readonly installed: readonly string[];
  /** The plugins of this call that were not tried. */
  readonly skipped: readonly string[];

  constructor(plugin: string, installed: readonly string[], skipped: readonly string[], cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `plugin "${plugin}" could not be installed: ${reason} (installed before it: ${installed.length === 0 ? "none" : installed.join(", ")}; not tried: ${skipped.length === 0 ? "none" : skipped.join(", ")})`,
      { cause },
    );
    this.plugin = plugin;
    this.installed = installed;
    this.skipped = skipped;
  }
}

/** A text a person typed fits several ids of one kind: the candidates are listed, the caller says more of it. */
export class AmbiguousId extends Error {
  override name = "AmbiguousId";
  readonly code = "AmbiguousId";
  /** What was typed. */
  readonly text: string;
  /** Every id it fits. */
  readonly candidates: readonly string[];

  constructor(text: string, what: string, candidates: readonly string[]) {
    const shown = candidates.slice(0, 5).join(", ");
    super(`"${text}" names ${String(candidates.length)} ${what}s: ${shown}${candidates.length > 5 ? ", …" : ""}: say more of it`);
    this.text = text;
    this.candidates = candidates;
  }
}

/** A text a person typed fits no id of the kind it was meant for. */
export class UnknownId extends Error {
  override name = "UnknownId";
  readonly code = "UnknownId";
  /** What was typed. */
  readonly text: string;

  constructor(text: string, what: string) {
    super(`no ${what} "${text}"`);
    this.text = text;
  }
}
