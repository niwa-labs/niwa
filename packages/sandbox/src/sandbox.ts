/**
 * The sandbox interface.
 *
 * One interface over two classes: the process class (srt, nono) is built; the microVM class
 * (Gondolin, BoxLite) is not, and nothing here assumes a process: a launched box is only
 * what a caller needs to talk to it and wait for it.
 */

import type { BoxSpec } from "./spec.ts";

export type SandboxName = "srt" | "nono" | "gondolin" | "boxlite";
export type SandboxClass = "process" | "vm";

/** The full configuration a sandbox will be given for one spec. A pure value of the spec. */
export interface SandboxManifest {
  readonly sandbox: SandboxName;
  readonly cwd: string;
  /** The whole environment of the process. */
  readonly env: Readonly<Record<string, string>>;
}

/** A launched box: its streams and its end. */
export interface LaunchedBox {
  readonly pid: number;
  readonly stdin: { write(data: string | Uint8Array): unknown; end(): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** The exit code; resolves once the process is gone and the sandbox has cleaned up after it. */
  readonly exited: Promise<number>;
  kill(): void;
}

export interface Sandbox<M extends SandboxManifest = SandboxManifest> {
  readonly name: SandboxName;
  readonly class: SandboxClass;
  /** Probes the machine: the binary is there and can really wrap a process. */
  available(): Promise<boolean>;
  /** Pure and deterministic: the same spec gives the same manifest. Recorded in the journal before launch. */
  manifest(spec: BoxSpec): M;
  /** Starts `argv` inside the box. Throws SandboxUnavailable when the sandbox cannot run here. */
  launch(spec: BoxSpec, argv: readonly string[]): Promise<LaunchedBox>;
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

/** The sandbox cannot express this spec. Silently weakening it would be worse than refusing. */
export class SandboxUnsupported extends Error {
  readonly sandbox: SandboxName;
  constructor(sandbox: SandboxName, reason: string) {
    super(`sandbox ${sandbox} cannot express this spec: ${reason}`);
    this.name = "SandboxUnsupported";
    this.sandbox = sandbox;
  }
}

/** The caller's gate: returns the sandbox when it can run, throws SandboxUnavailable when it cannot. */
export async function requireSandbox<S extends Sandbox>(sandbox: S): Promise<S> {
  if (!(await sandbox.available())) throw new SandboxUnavailable(sandbox.name, "the probe failed");
  return sandbox;
}
