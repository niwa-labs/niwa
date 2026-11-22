/**
 * The `spawnAgent` funnel: the one place an agent process is born.
 *
 * Every harness starts its process here. The funnel builds the environment (the inherited one plus
 * the session's additions), and when the launch asks for a box it takes the box's sandbox, records
 * the manifest, and launches through the sandbox. What the harness needs inside the box is in the
 * spec already: its profile was resolved with the rest of the box. A sandbox that is required and unavailable stops the start: the error is
 * `SandboxUnavailable` and no process exists.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { Readable } from "node:stream";

import { nono } from "./nono.ts";
import { BoxRefused, listenRefusal, requireSandbox } from "./sandbox.ts";
import type { LaunchedBox, Sandbox, SandboxManifest, SandboxName } from "./sandbox.ts";
import { boxSpec } from "./spec.ts";
import type { BoxSpec, BoxSpecInput } from "./spec.ts";
import { srt } from "./srt.ts";

/** The sandboxes a launch may name: the process class. */
export type BoxSandboxName = "srt" | "nono";

/** A box a session must run in: the sandbox and what it may reach. */
export interface BoxRequest {
  /** The sandbox by its name, or the sandbox itself for a host that made its own. */
  readonly sandbox: BoxSandboxName | Sandbox;
  readonly spec: BoxSpecInput;
  /** Whoever asked for the box, so the manifest of its launch can be told from another's: it goes on to the record. */
  readonly mark?: string;
}

/** Why a resume that reuses a running process cannot take new tools or a new box. */
export const LIVE_PROCESS_REFUSAL = "a running session keeps the tools and the box its process was born with";

/** A path under the user's home directory, absolute. */
export function homePath(...parts: readonly string[]): string {
  return join(homedir(), ...parts);
}

export interface AgentLaunch {
  /** The harness instance that starts the process, for the records. */
  readonly harness: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Added to the inherited environment: the session's `NIWA_ID` and what the harness sets for itself. */
  readonly env?: Readonly<Record<string, string>>;
  /** Names removed from the inherited environment before the additions go on. */
  readonly unset?: readonly string[];
  /** The process leads its own process group, so a stop reaches everything it started. */
  readonly detached?: boolean;
  /** Run inside a sandbox. */
  readonly box?: BoxRequest;
}

/**
 * The part of a child process the harnesses use. A node `ChildProcess` started with pipes is one;
 * so is the process of a boxed launch.
 */
export interface AgentProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

/** One process, as the funnel started it. */
export interface SpawnEvent {
  readonly harness: string;
  /** The program and its arguments, as they were run: inside the wrapper's own argv when boxed. */
  readonly argv: readonly string[];
  readonly cwd: string | undefined;
  /** The additions to the environment, not the whole of it. */
  readonly env: Readonly<Record<string, string>>;
  readonly sandbox: SandboxName | undefined;
}

/** The manifest of a box, as it will be given to the sandbox. */
export interface BoxRecord {
  readonly harness: string;
  /** The mark of the request, when it had one. */
  readonly mark?: string;
  readonly sandbox: SandboxName;
  /** The spec, with the environment the process is started with. */
  readonly spec: BoxSpec;
  readonly manifest: SandboxManifest;
}

const spawnListeners = new Set<(event: SpawnEvent) => void>();
const boxListeners = new Set<(record: BoxRecord) => void | Promise<void>>();

/** Hears every process the funnel starts, as it starts. Returns the unsubscribe. */
export function onSpawn(listener: (event: SpawnEvent) => void): () => void {
  spawnListeners.add(listener);
  return () => void spawnListeners.delete(listener);
}

/**
 * Hears the manifest of every box before its process is started, and is waited for: a record that
 * cannot be made stops the launch. Returns the unsubscribe.
 */
export function onBoxManifest(listener: (record: BoxRecord) => void | Promise<void>): () => void {
  boxListeners.add(listener);
  return () => void boxListeners.delete(listener);
}

const sandboxes = new Map<BoxSandboxName, Sandbox>();

/** The sandbox a request names: the one it holds, or the one the funnel keeps under its name. */
export function sandboxOf(named: BoxSandboxName | Sandbox): Sandbox {
  if (typeof named !== "string") return named;
  const name = named;
  let found = sandboxes.get(name);
  if (found === undefined) {
    found = name === "srt" ? srt() : nono();
    sandboxes.set(name, found);
  }
  return found;
}

/** Replaces the sandbox the funnel uses under a name, for a host that knows where its binary is. Returns the restore. */
export function useSandbox(name: BoxSandboxName, sandbox: Sandbox): () => void {
  const before = sandboxes.get(name);
  sandboxes.set(name, sandbox);
  return () => {
    if (before === undefined) sandboxes.delete(name);
    else sandboxes.set(name, before);
  };
}

/** Refuses a start whose box cannot run here: `SandboxUnavailable`, before any process exists. */
export async function requireBox(box: BoxRequest | undefined): Promise<void> {
  if (box !== undefined) await requireSandbox(sandboxOf(box.sandbox));
}

function inherited(unset: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !unset.includes(name)) env[name] = value;
  }
  return env;
}

/**
 * The spec a box is given: the request's, with the environment of the launch. The environment is
 * only what is listed: `HOME` and `PATH` so the harness can find itself, then the spec's own, then
 * the session's additions.
 */
function boxedSpec(launch: AgentLaunch, box: BoxRequest): BoxSpec {
  const given = boxSpec(box.spec);
  return boxSpec({
    ...given,
    cwd: launch.cwd ?? given.cwd,
    env: { HOME: homedir(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...given.env, ...launch.env },
  });
}

/** How a boxed process ended, as it is told to those who listen. */
interface Outcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

type EndListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type Listener = Parameters<EventEmitter["on"]>[1];

type BoxInput = LaunchedBox["stdin"];
interface InputOperation {
  send(input: BoxInput): unknown;
  finish(error?: Error): void;
}

/**
 * The process of a boxed launch, in the shape of a child process: streams, an exit, a kill.
 *
 * The end of a box can come before the one who started it holds the process. Such a late listener
 * for `exit`, `close` or the `error` of a failed clean-up is told what happened, as soon as it is registered, rather than waiting for an
 * event that will not come again.
 */
class BoxedProcess extends EventEmitter implements AgentProcess {
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, finish) => this.#writeInput({ send: (input) => input.write(chunk), finish }),
    final: (finish) => this.#writeInput({ send: (input) => input.end(), finish }),
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  #box: LaunchedBox | undefined;
  /** A signal sent before the box was there: it is delivered the moment the box is. */
  #unsent: NodeJS.Signals | number | undefined;
  #exited: Outcome | undefined;
  #closed: Outcome | undefined;
  #failure: Error | undefined;
  #input: InputOperation | undefined;

  constructor() {
    super();
    // The callback and stream still report the error to readers. A caller that just writes and
    // watches the process exit need not install a second, otherwise-unhandled error listener.
    this.stdin.on("error", () => {});
  }

  get pid(): number | undefined {
    return this.#box?.pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (this.#box === undefined) this.#unsent = signal ?? "SIGTERM";
    else this.#box.kill(signal);
    return true;
  }

  override on(event: "close" | "exit", listener: EndListener): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: string | symbol, listener: Listener): this;
  override on(event: string | symbol, listener: Listener): this {
    return this.#told(event, listener) ? this : super.on(event, listener);
  }

  override once(event: "close" | "exit", listener: EndListener): this;
  override once(event: "error", listener: (error: Error) => void): this;
  override once(event: string | symbol, listener: Listener): this;
  override once(event: string | symbol, listener: Listener): this {
    return this.#told(event, listener) ? this : super.once(event, listener);
  }

  /** Tells a listener of an end that has happened already; false when the end is still to come. */
  #told(event: string | symbol, listener: Listener): boolean {
    const failure = this.#failure;
    if (event === "error" && failure !== undefined) {
      setImmediate(() => (listener as (error: Error) => void)(failure));
      return true;
    }
    const outcome = event === "exit" ? this.#exited : event === "close" ? this.#closed : undefined;
    if (outcome === undefined) return false;
    setImmediate(() => (listener as EndListener)(outcome.code, outcome.signal));
    return true;
  }

  attach(box: LaunchedBox): void {
    this.#box = box;
    if (this.#unsent !== undefined) box.kill(this.#unsent);
    if (this.#input !== undefined) void this.#sendInput(this.#input, box.stdin);
    // Do not hold the input callbacks behind a sandbox's cleanup or a blocked sink write.
    void (box.ended ?? box.exited).then(
      () => this.#closeInput(Object.assign(new Error("The boxed process closed its input"), { code: "EPIPE" })),
      (error: unknown) => this.#closeInput(error instanceof Error ? error : new Error(String(error))),
    );
    const drained = Promise.all([pump(box.stdout, this.stdout), pump(box.stderr, this.stderr)]).then(() => undefined, () => undefined);
    void box.exited.then(
      async (code) => this.#end(code, (await box.signaled) ?? null, undefined, drained),
      (error: unknown) => this.#end(null, null, error, drained),
    );
  }

  #writeInput(operation: InputOperation): void {
    this.#input = operation;
    if (this.#box !== undefined) void this.#sendInput(operation, this.#box.stdin);
  }

  /** Writable runs one operation at a time. Keep its callback pending until the real sink accepts it. */
  async #sendInput(operation: InputOperation, input: BoxInput): Promise<void> {
    try {
      await operation.send(input);
    } catch (error) {
      this.#finishInput(operation, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.#finishInput(operation);
  }

  #finishInput(operation: InputOperation, error?: Error): void {
    // The sink may settle after exit has already failed this operation.
    if (this.#input !== operation) return;
    this.#input = undefined;
    operation.finish(error);
  }

  #closeInput(error: Error): void {
    if (this.#input !== undefined) this.#finishInput(this.#input, error);
    else this.stdin.destroy();
  }

  /**
   * The box is gone, by a code or by the signal that ended it. A clean-up that failed leaves the process ended without a code: the exit is
   * told with `null`, and the failure goes to whoever listens for `error`. An error nobody is
   * listening for is not thrown.
   */
  async #end(code: number | null, signal: NodeJS.Signals | null, failure: unknown, drained: Promise<void>): Promise<void> {
    // As a child process tells it: a process ended by a signal has no exit code, whatever status it left.
    const outcome: Outcome = signal === null ? { code, signal } : { code: null, signal };
    this.exitCode = outcome.code;
    this.signalCode = outcome.signal;
    this.#exited = outcome;
    if (failure !== undefined) this.#failure = failure instanceof Error ? failure : new Error(String(failure));
    this.emit("exit", outcome.code, outcome.signal);
    if (this.#failure !== undefined && this.listenerCount("error") > 0) this.emit("error", this.#failure);
    await drained;
    this.#closed = outcome;
    this.emit("close", outcome.code, outcome.signal);
  }

  /** The launch failed after the process was handed out; whoever holds it hears of it once it can listen. */
  fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    // Kept before anyone is told, so a listener that comes later is told the same.
    this.#failure = failure;
    this.#closed = { code: null, signal: null };
    this.#closeInput(failure);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      if (this.listenerCount("error") > 0) this.emit("error", failure);
      this.emit("close", null, null);
    });
  }
}

/** Resolves when the stream can take more, or can take nothing more. */
function drained(stream: PassThrough): Promise<void> {
  // The reader that went away has no `drain` or `close` still to come.
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

/** Copies a box's output to a stream at the pace of its reader: nothing is read while the stream is full. */
async function pump(from: ReadableStream<Uint8Array>, to: PassThrough): Promise<void> {
  const reader = from.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (to.destroyed) {
        await reader.cancel();
        break;
      }
      if (!to.write(value)) await drained(to);
      if (to.destroyed) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    to.end();
  }
}

function announce(launch: AgentLaunch, argv: readonly string[], sandbox: SandboxName | undefined): void {
  const event: SpawnEvent = { harness: launch.harness, argv, cwd: launch.cwd, env: launch.env ?? {}, sandbox };
  for (const listener of spawnListeners) listener(event);
}

/** The spec with its environment, the manifest made from it, and the listeners told: all before anything starts. */
async function admitBox(launch: AgentLaunch, request: BoxRequest, probeAfterManifest = false): Promise<{ sandbox: Sandbox; spec: BoxSpec }> {
  const sandbox = sandboxOf(request.sandbox);
  const spec = boxedSpec(launch, request);
  const manifest = sandbox.manifest(spec);
  const listener = listenRefusal(spec, manifest);
  if (listener !== undefined) throw new BoxRefused([listener], sandbox.name);
  if (probeAfterManifest) await requireSandbox(sandbox);
  const record: BoxRecord = {
    harness: launch.harness,
    ...(request.mark === undefined ? {} : { mark: request.mark }),
    sandbox: sandbox.name,
    spec,
    manifest,
  };
  for (const listener of boxListeners) await listener(record);
  return { sandbox, spec };
}

function argvOf(launch: AgentLaunch): string[] {
  return [launch.program, ...launch.args];
}

function spawnPlain(launch: AgentLaunch): PipedProcess {
  announce(launch, argvOf(launch), undefined);
  return spawn(launch.program, [...launch.args], {
    cwd: launch.cwd,
    env: { ...inherited(launch.unset ?? []), ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: launch.detached ?? false,
  });
}

/** A child process started with pipes. */
type PipedProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** The process once it is running, or the error that kept it from running: the program is not there, or may not be run. */
function spawned(child: PipedProcess): Promise<PipedProcess> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => {
      child.off("error", reject);
      resolve(child);
    });
    child.once("error", reject);
  });
}

/** The funnel: every agent process is started here. Any refusal is typed and comes before the process. */
export async function spawnAgent(launch: AgentLaunch): Promise<AgentProcess> {
  if (launch.box === undefined) return await spawned(spawnPlain(launch));
  const needsListener = launch.box.spec.listen !== undefined;
  // The manifest can refuse unsupported listeners without probing the runtime.
  if (!needsListener) await requireBox(launch.box);
  const { sandbox, spec } = await admitBox(launch, launch.box, needsListener);
  announce(launch, argvOf(launch), sandbox.name);
  const child = new BoxedProcess();
  child.attach(await sandbox.launch(spec, argvOf(launch), { detached: launch.detached ?? false }));
  return child;
}

/**
 * Starts the process of a launch and returns it at once, for a host that must have it in hand
 * synchronously: the Claude SDK's spawn hook. A boxed launch is admitted and launched behind the
 * returned process, and a failure reaches it as an `error`; the caller has passed `requireBox`
 * first, so the usual refusal is typed and came before.
 */
export function spawnAgentNow(launch: AgentLaunch): AgentProcess {
  const request = launch.box;
  if (request === undefined) return spawnPlain(launch);
  const child = new BoxedProcess();
  void admitBox(launch, request)
    .then(({ sandbox, spec }) => {
      announce(launch, argvOf(launch), sandbox.name);
      return sandbox.launch(spec, argvOf(launch), { detached: launch.detached ?? false });
    })
    .then((box) => child.attach(box), (error: unknown) => child.fail(error));
  return child;
}
