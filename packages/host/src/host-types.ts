// How a host is opened, and what a host is.
import type { Caller, Clock, Grant, PluginName, Principal, Token } from "@niwa-labs/core";
import type { Plugin } from "@niwa-labs/plugin";
import type { NiwaApi } from "@niwa-labs/client";

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
  /** Open the journal as the only writer, resume work, catch up, listen for clients. */
  serve(): Promise<void>;
  /**
   * Make a token for a principal, for a process that connects by itself (a plugin that lives out
   * of process, an external client). In-process only: nothing over the wire makes tokens.
   */
  issueToken(principal: Principal, opts?: { grant?: Grant; parent?: Caller }): Token;
}
