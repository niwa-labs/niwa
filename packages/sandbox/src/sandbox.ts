/**
 * The sandbox interface.
 *
 * One interface over two classes: the process class (srt, nono) is built; the microVM class
 * (Gondolin, BoxLite) is not, and nothing here assumes a process: a launched box is only
 * what a caller needs to talk to it and wait for it.
 */

import { LoopbackListenSchema, listenerName, sameListener } from "./spec.ts";
import type { BoxSpec, LoopbackListen } from "./spec.ts";
import { covers, realPlace } from "./profile.ts";
import { anchoredSpec } from "./paths.ts";

export type SandboxName = "srt" | "nono" | "gondolin" | "boxlite";
export type SandboxClass = "process" | "vm";

/**
 * What a box lets its process reach once the sandbox has applied a spec: the places the spec lists
 * and what the sandbox adds of its own. A path is absolute, with `~` expanded.
 */
export interface BoxPolicy {
  /** Every place the process may write, besides the devices. */
  readonly write: readonly string[];
  /** The devices the process may write to run: the null device, the terminal, its descriptors. */
  readonly devices: readonly string[];
  /** Reads: only the places listed, or every place but those listed. */
  readonly read: { readonly only: readonly string[] } | { readonly except: readonly string[] };
  /** The only hosts the process may connect to. */
  readonly net: readonly string[];
  /** The sole host-reachable inbound TCP listener the sandbox applies. */
  readonly listen?: LoopbackListen;
  /** Generic-password services readable for the current macOS account. */
  readonly keychainRead?: readonly string[];
  /** Directories where the adapter applies direct-child Unix socket bind permissions. */
  readonly unixSocketBind?: readonly string[];
}

/** The full configuration a sandbox will be given for one spec. A pure value of the spec. */
export interface SandboxManifest {
  readonly sandbox: SandboxName;
  readonly cwd: string;
  /** The whole environment of the process. */
  readonly env: Readonly<Record<string, string>>;
  /** What the box will let the process reach. Absent: the sandbox does not say, and nothing is promised beyond the spec. */
  readonly policy?: BoxPolicy;
}

/** A launched box: its streams and its end. */
export interface LaunchedBox {
  readonly pid: number;
  readonly stdin: { write(data: string | Uint8Array): unknown; end(): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /**
   * The exit code; resolves once the process is gone and the sandbox has cleaned up after it. Rejects
   * when the clean-up fails: the process is gone all the same, and the caller must not take it for running.
   */
  readonly exited: Promise<number>;
  /**
   * The exit code as soon as the process is gone, before the sandbox has cleaned up after it. Absent
   * where the sandbox has no step of its own after the process: `exited` is then the same moment.
   */
  readonly ended?: Promise<number>;
  /**
   * The signal that ended the wrapper, `null` when it exited by itself; settled no later than
   * `exited`. A process killed by a signal also has a conventional exit code (143 for SIGTERM): this
   * tells the two apart, as a child process's `signalCode` does. A box that cannot tell may leave it out.
   */
  readonly signaled?: Promise<NodeJS.Signals | null>;
  /** Signals the wrapper's process (SIGTERM by default), as a child process's `kill` does. */
  kill(signal?: NodeJS.Signals | number): void;
}

/** How a box's process is started, besides what the spec says. */
export interface LaunchOptions {
  /** The process leads its own process group, so a signal to the group reaches everything it started. */
  readonly detached?: boolean;
  /** Trusted process-only environment, outside the manifest and spawn events. */
  readonly privateEnv?: Readonly<Record<string, string>>;
}

export interface Sandbox<M extends SandboxManifest = SandboxManifest> {
  readonly name: SandboxName;
  readonly class: SandboxClass;
  /** Probes the machine: the binary is there and can really wrap a process. */
  available(): Promise<boolean>;
  /** Pure and deterministic. A requested listener must match `policy.listen` exactly or be refused. */
  manifest(spec: BoxSpec): M;
  /** Starts `argv` inside the box. Refuses any spec the sandbox cannot enforce before spawning. */
  launch(spec: BoxSpec, argv: readonly string[], options?: LaunchOptions): Promise<LaunchedBox>;
}

/** A session that needs a sandbox and has none available must not start. */
export class SandboxUnavailable extends Error {
  readonly sandbox: SandboxName;
  constructor(sandbox: SandboxName, reason: string) {
    super(`sandbox ${sandbox} is not available: ${reason}`);
    this.name = "SandboxUnavailable";
    this.sandbox = sandbox;
  }
}

/** Why a box was refused: one reason, with what it is about. */
export interface BoxRefusal {
  /**
   * `unknown-profile`: a name no profile has. `closed`: a place another box's profile or the closed
   * list keeps. `not-granted`: wider than the host's default, and no rule of the grant covers it.
   * `no-network`: network access was asked for and disabled. `adapter`: the sandbox cannot hold it.
   */
  readonly code: "unknown-profile" | "closed" | "not-granted" | "no-network" | "adapter";
  readonly message: string;
  /** The rule of a grant that would cover what was refused. */
  readonly rule?: string;
}

/** A backend may enforce exactly the declared listener, or refuse the spec. */
export function listenRefusal(spec: BoxSpec, manifest: SandboxManifest): BoxRefusal | undefined {
  const applied = manifest.policy?.listen;
  if (spec.listen === undefined && applied === undefined) return undefined;
  const confirmed = LoopbackListenSchema.safeParse(applied);
  if (spec.listen !== undefined && confirmed.success && sameListener(spec.listen, confirmed.data)) return undefined;
  return {
    code: "adapter",
    message: spec.listen === undefined
      ? "the sandbox applies an unrequested TCP loopback listener"
      : `the sandbox does not confirm an exact listener on ${listenerName(spec.listen)} for ${spec.listen.from}`,
  };
}

/** An adapter must confirm exactly the Keychain services in the spec. */
export function keychainReadRefusal(spec: BoxSpec, manifest: SandboxManifest): BoxRefusal | undefined {
  const wanted = new Set(spec.keychainRead);
  const applied = new Set(manifest.policy?.keychainRead);
  if (wanted.size === applied.size && [...wanted].every((service) => applied.has(service))) return undefined;
  return { code: "adapter", message: "the sandbox does not confirm the exact requested Keychain services" };
}

/** An adapter must report the exact requested directory set and preserve closed paths. */
export function socketBindRefusals(given: BoxSpec, manifest: SandboxManifest): BoxRefusal[] {
  const applied = manifest.policy?.unixSocketBind ?? [];
  if (given.unixSocketBind.length === 0 && applied.length === 0) return [];
  const spec = anchoredSpec(given);
  const wanted = new Set(spec.unixSocketBind.map((dir) => realPlace(dir)));
  const reasons: BoxRefusal[] = [];
  if (new Set(applied).size !== wanted.size || applied.some((dir) => !wanted.has(dir))) {
    reasons.push({ code: "adapter", message: "the sandbox does not confirm the exact requested Unix socket bind directories" });
  }
  for (const path of spec.closed) {
    const closed = realPlace(path);
    for (const dir of wanted) {
      if (covers(closed, dir) || covers(dir, closed)) {
        reasons.push({ code: "closed", message: `Unix socket bind directory ${dir} overlaps closed path ${closed}` });
      }
    }
  }
  return reasons;
}

/**
 * A box that cannot be had as it was asked for, with every reason at once. Silently widening or
 * narrowing it would be worse than refusing: nothing was started.
 */
export class BoxRefused extends Error {
  readonly reasons: readonly BoxRefusal[];
  readonly sandbox: SandboxName | undefined;
  constructor(reasons: readonly BoxRefusal[], sandbox?: SandboxName) {
    super(`${sandbox === undefined ? "the box" : `sandbox ${sandbox}`} was refused: ${reasons.map((reason) => reason.message).join("; ")}`);
    this.name = "BoxRefused";
    this.reasons = reasons;
    this.sandbox = sandbox;
  }
}

/** The caller's gate: returns the sandbox when it can run, throws SandboxUnavailable when it cannot. */
export async function requireSandbox<S extends Sandbox>(sandbox: S): Promise<S> {
  if (!(await sandbox.available())) throw new SandboxUnavailable(sandbox.name, "the probe failed");
  return sandbox;
}
