// How a host is opened, and what a host is.
import type { Caller, Grant, InvocationId, PluginName, Principal, Seq, Token, JsonValue, Clock } from "@niwa-labs/core";
import type { Plugin } from "@niwa-labs/plugin";
import type { NiwaApi } from "@niwa-labs/client";

/**
 * What a shadow run was asked to run.
 *
 * The run starts from the journal as it was at that position, not as it is now.
 */
export interface ShadowOptions {
  /** The first position the shadow sees. Default: from the beginning. */
  from?: Seq;
  /** The last position the shadow sees. Default: as far as the journal goes. */
  to?: Seq;
}

/** One step of one invocation, as a shadow run saw it. */
export interface ShadowStep {
  /** The invocation the step belongs to. */
  invocation: InvocationId;
  /** The key of the step: the same key the recorded step has. */
  key: string;
  /** What kind of step it is: a call to an action, or a record the handler wrote. */
  kind: "step" | "emit";
  /**
   * What became of the step in the shadow run.
   *
   * - "matched": the action and the final input are the recorded ones, or the record written is
   * - "differed": a record the handler writes is not the recorded one
   * - "simulated": the call had no recorded answer, and a simulator answered it
   * - "not-evaluated": the call had no recorded answer, and nothing could answer it
   */
  status: "matched" | "differed" | "simulated" | "not-evaluated";
  /** What the recorded intent said: the action, and the input it was called with. */
  recorded: {
    /** The action that was called. */
    action: string;
    /** The input it was called with, as it was recorded. */
    input: JsonValue | undefined;
    /** The outcome that was recorded, when there is one. */
    outcome: JsonValue | undefined;
  } | undefined;
  /** What the shadow run did: the action, and the input it would have called it with. */
  attempted: {
    /** The action the shadow run called. */
    action: string;
    /** The input the shadow run would have called it with. */
    input: JsonValue | undefined;
  } | undefined;
  /** The outcome the shadow run would have produced. */
  newOutcome: JsonValue | undefined;
}

/** What a shadow run found: the three parts of the report. */
export interface ShadowReport {
  /** The calls whose action and final input are the recorded ones, and the records written as recorded. */
  matched: ShadowStep[];
  /** The records the handler writes that are not the recorded ones. */
  differed: ShadowStep[];
  /** The steps that had no recorded answer: not evaluated, or simulated. */
  notEvaluated: ShadowStep[];
}

/** How a host is opened. */
export interface HostOptions {
  /** The home of the host: where its journal, its socket and its state live. */
  home: string;
  /** Take the journal even from a living holder. */
  takeover?: boolean;
  /** What `niwa.host.stop` does. Default: close the host. A process that serves it ends itself here. */
  onStop?: () => void;
  /**
   * The clock of this host.
   *
   * One host has one clock: everything that asks what time it is, or that waits for a moment to
   * come, asks it. The default is the real clock; a test may give the host a clock it moves by
   * hand, so that a week of work is watched without a week of waiting.
   */
  clock?: Clock;
}

export interface Host extends NiwaApi {
  /**
   * Install or replace plugins, in the order given (same name = replace).
   *
   * Stops at the first plugin that cannot be installed and throws `PluginInstallFailed` naming it:
   * the plugins before it stay installed, the ones after it are not tried.
   */
  use(...plugins: Plugin[]): void;
  /** Remove a plugin's registrations. Its records stay. */
  unload(name: PluginName): void;
  /** The plugin that is installed under this name, as it was given to `use`. */
  installed(name: PluginName): Plugin | undefined;
  /**
   * Run a plugin's handlers over the records that were already written, and report what they
   * would have done differently.
   *
   * Nothing is written to the journal and no action is called.
   */
  shadow(plugin: Plugin, opts?: ShadowOptions): Promise<ShadowReport>;
  /** Open the journal as the only writer, resume work, catch up, listen for clients. */
  serve(): Promise<void>;
  /**
   * Make a token for a principal, for a process that connects by itself (a plugin that lives out
   * of process, an external client). In-process only: nothing over the wire makes tokens.
   */
  issueToken(principal: Principal, opts?: { grant?: Grant; parent?: Caller }): Token;
}
