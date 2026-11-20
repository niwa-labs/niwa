/**
 * The `spawnAgent` funnel: the one place an agent process is born.
 *
 * Every harness starts its process here. The funnel builds the environment (the inherited one plus
 * the session's additions), and when the launch asks for a box it takes the box's sandbox, adds
 * what the harness needs to live in it to the spec, records the manifest, and launches through
 * the sandbox. A sandbox that is required and unavailable stops the start: the error is
 * `SandboxUnavailable` and no process exists.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

import { nono } from "./nono.ts";
import { requireSandbox } from "./sandbox.ts";
import type { LaunchedBox, Sandbox, SandboxManifest, SandboxName } from "./sandbox.ts";
import { boxSpec } from "./spec.ts";
import type { BoxSpec, BoxSpecInput } from "./spec.ts";
import { srt } from "./srt.ts";

/** The sandboxes a launch may name: the process class. */
export type BoxSandboxName = "srt" | "nono";

/** A box a session must run in: the sandbox and what it may reach. */
export interface BoxRequest {
  readonly sandbox: BoxSandboxName;
  readonly spec: BoxSpecInput;
  /** Whoever asked for the box, so the manifest of its launch can be told from another's: it goes on to the record. */
  readonly mark?: string;
}

/** What a harness needs to live inside a box, apart from what the grant gives. Added to the spec, visibly. */
export interface HarnessNeeds {
  /** The harness's own directories, absolute: its logs and authorisation live there. */
  readonly write: readonly string[];
  /** The hosts of its model endpoint, where the harness has a fixed one. */
  readonly net: readonly string[];
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
  /** What the harness needs inside a box. */
  readonly needs?: HarnessNeeds;
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
  readonly sandbox: BoxSandboxName;
  /** The spec with the harness's needs added. */
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

function sandboxOf(name: BoxSandboxName): Sandbox {
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

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * The spec a box is given: the grant's spec with the harness's needs added, so nothing the
 * sandbox allows is hidden. The environment is only what is listed: `HOME` and `PATH` so the
 * harness can find itself, then the spec's own, then the session's additions.
 */
function boxedSpec(launch: AgentLaunch, box: BoxRequest): BoxSpec {
  const given = boxSpec(box.spec);
  const needs = launch.needs ?? { write: [], net: [] };
  return boxSpec({
    cwd: launch.cwd ?? given.cwd,
    read: given.read,
    write: unique([...given.write, ...needs.write]),
    denyRead: given.denyRead,
    net: unique([...given.net, ...needs.net]),
    env: { HOME: homedir(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...given.env, ...launch.env },
    sockets: given.sockets,
  });
}

/** The process of a boxed launch, in the shape of a child process: streams, an exit, a kill. */
class BoxedProcess extends EventEmitter implements AgentProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  #box: LaunchedBox | undefined;

  get pid(): number | undefined {
    return this.#box?.pid;
  }

  kill(): boolean {
    this.killed = true;
    this.#box?.kill();
    return true;
  }

  attach(box: LaunchedBox): void {
    this.#box = box;
    if (this.killed) box.kill();
    this.stdin.on("data", (chunk: Buffer) => box.stdin.write(chunk));
    this.stdin.on("end", () => box.stdin.end());
    const drained = Promise.all([pump(box.stdout, this.stdout), pump(box.stderr, this.stderr)]);
    void box.exited.then(async (code) => {
      this.exitCode = code;
      this.emit("exit", code, null);
      await drained;
      this.emit("close", code, null);
    });
  }

  /** The launch failed after the process was handed out; whoever holds it hears of it once it can listen. */
  fail(error: unknown): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      this.emit("close", null, null);
    });
  }
}

async function pump(from: ReadableStream<Uint8Array>, to: PassThrough): Promise<void> {
  const reader = from.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      to.write(value);
    }
  } finally {
    to.end();
  }
}

function announce(launch: AgentLaunch, argv: readonly string[], sandbox: SandboxName | undefined): void {
  const event: SpawnEvent = { harness: launch.harness, argv, cwd: launch.cwd, env: launch.env ?? {}, sandbox };
  for (const listener of spawnListeners) listener(event);
}

/** The spec with the needs, the manifest made from it, and the listeners told: all before anything starts. */
async function admitBox(launch: AgentLaunch, request: BoxRequest): Promise<{ sandbox: Sandbox; spec: BoxSpec }> {
  const sandbox = sandboxOf(request.sandbox);
  const spec = boxedSpec(launch, request);
  const record: BoxRecord = {
    harness: launch.harness,
    ...(request.mark === undefined ? {} : { mark: request.mark }),
    sandbox: request.sandbox,
    spec,
    manifest: sandbox.manifest(spec),
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
  await requireBox(launch.box);
  const { sandbox, spec } = await admitBox(launch, launch.box);
  announce(launch, argvOf(launch), sandbox.name);
  const child = new BoxedProcess();
  child.attach(await sandbox.launch(spec, argvOf(launch)));
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
      return sandbox.launch(spec, argvOf(launch));
    })
    .then((box) => child.attach(box), (error: unknown) => child.fail(error));
  return child;
}
