/**
 * The control side for Claude Code: how niwa starts, steers and stops the sessions of Claude
 * Code.
 *
 * Claude Code speaks the Agent Client Protocol, so this side is the ACP control with the
 * things that are only Claude Code's: which adapter to run, which model it should use, and
 * how a permission request should be answered when no reverse handler takes it.
 *
 * The adapter is `@zed-industries/claude-code-acp`, which drives the Claude Code SDK. It is
 * started as a child process that speaks JSON-RPC over stdio: `initialize`, `session/new`,
 * `session/prompt`, `session/cancel`, `session/set_model`, `session/set_mode`.
 *
 * The permission policy is `"allow"` by default, `"deny"`, or a function that
 * decides per request. The ACP protocol names the option the agent offers for each decision,
 * so the policy picks one of the offered options rather than inventing an id.
 *
 * Process ownership and termination come from the ACP control: the child leads its own process
 * group and a stop is a group signal with a grace period and a hard-kill escalation.
 */

import { fileURLToPath } from "node:url";

import type {
  AskAnswer,
  AskOptions,
  DeliveryReceipt,
  LifeEvent,
  Prompt,
  ResumeOptions,
  SendOptions,
  SessionControl,
  SessionState,
  StartOptions,
  StartedSession,
  SessionMode,
  BundledProgram,
  SessionId,
  ClaudeOptions,
} from "@niwa-labs/harness";
import { CLAUDE_CODE_LAUNCH } from "./launch.ts";
import { modeOf, requireLaunch, HarnessIdSchema, findBundled } from "@niwa-labs/harness";

import {
  claudeAcpControl,
  type ClaudeAcpPermissionDecision,
  type ClaudeAcpPermissionPolicy,
  type ClaudeAcpPermissionRequest,
  type ClaudeAcpSessionControl,
} from "./acp/control.ts";

/**
 * A tool the agent wants to use.
 */
export interface PermissionRequest {
  /** The tool the agent named, when it named one. */
  readonly tool: string;
  /** The input the agent wants to pass to the tool. */
  readonly input: unknown;
  /** The call id of the tool call, when the agent gave one. */
  readonly toolUseId: string | undefined;
}

/**
 * What happens when a tool asks for permission. `"allow"` (the default) lets the tool run,
 * `"deny"` refuses it, and a function decides per request; a function that throws denies.
 */
export type PermissionPolicy = "allow" | "deny" | ((request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision);

/**
 * What this side decided about a permission request.
 */
export type PermissionDecision =
  | { readonly behavior: "allow" }
  | { readonly behavior: "deny"; readonly message?: string };

/**
 * How the control side is set up.
 */
export interface ClaudeCodeControlOptions {
  /** The harness instance id: half of a session's identity. */
  readonly harness: string;

  /** Claude Code's own options: `advisor: false` switches its advisor off; left out, the owner's config stands. */
  readonly claude?: ClaudeOptions;

  /**
   * The ACP adapter that drives Claude Code.
   *
   * It is a command: the first element is the program and the rest are its arguments. It
   * defaults to the adapter of niwa's own `@zed-industries/claude-code-acp` dependency.
   */
  readonly command?: readonly string[];

  /**
   * The model, when the caller does not choose one per start. Claude Code's ACP adapter names
   * its models `default`, `sonnet`, `haiku` and `opus`; the program it drives says which model
   * each alias means, and a full model id is passed to it unchanged. Pin an instance to a full id
   * where it must not move with the alias. A model the session does not take fails the start.
   */
  readonly model?: string;

  /**
   * The effort level, when the caller does not choose one per start: the `--effort` flag of the
   * program (low, medium, high, xhigh, max). A session keeps it for its whole life.
   */
  readonly effort?: string;

  /**
   * The Claude Code program the adapter drives, as a path.
   *
   * It defaults to the `claude` on the PATH: the owner's own Claude Code, never a copy niwa
   * carries. A start with neither this nor a `claude` on the PATH fails and says so.
   */
  readonly executable?: string;

  /**
   * What happens when a tool asks for permission.
   */
  readonly permissions?: PermissionPolicy;

  /**
   * The working mode, when the caller does not choose one per start. Default: `auto`. The adapter
   * has no `auto` of its own: `ask` is its `default`, `auto` its `acceptEdits`, `full` its
   * `bypassPermissions`.
   */
  readonly mode?: SessionMode;

  /** How long one call waits for its answer, in milliseconds. */
  readonly callTimeoutMs?: number;

  /** How long a turn waits for its answer, in milliseconds. */
  readonly turnTimeoutMs?: number;

  /** How long a graceful stop waits before the hard kill, in milliseconds. */
  readonly stopGraceMs?: number;
}

/**
 * A `SessionControl` that can also stop what it started.
 */
export interface ClaudeCodeSessionControl extends SessionControl {
  /** Stops a session and the process it owns. */
  stop(id: SessionId): Promise<void>;

  /** Stops every process this control side started, including a start still in progress. */
  dispose(): Promise<void>;
}

/**
 * The ACP adapter niwa ships, as this package finds it: this package declares the dependency, so
 * it is the one that resolves the script and reads the version, and discovery is handed the result.
 * Discovery proposes it as the program that runs the kind; niwa runs it through its own entry.
 */
export const CLAUDE_CODE_ADAPTER: BundledProgram = findBundled(import.meta.url, {
  package: "@zed-industries/claude-code-acp",
  entry: "dist/index.js",
});

/**
 * The ACP adapter that drives Claude Code: niwa's own dependency, started through niwa's own entry
 * (`acp/adapter.ts`, which lets a session keep AskUserQuestion), run by the runtime that runs niwa.
 * A host started from anywhere finds it without `node_modules/.bin` on the PATH.
 */
function defaultCommand(): readonly string[] {
  return [process.execPath, fileURLToPath(new URL("./acp/adapter.ts", import.meta.url))];
}

/**
 * The owner's own Claude Code: the `claude` on the PATH. niwa does not fall back to a copy it
 * carries: a machine without one is told so.
 */
export function localClaude(): string {
  const found = Bun.which("claude", { PATH: process.env.PATH ?? "" });
  if (found === null) {
    throw new Error('there is no `claude` on the PATH: install Claude Code, or give the instance "control.executable"');
  }
  return found;
}

/**
 * Build the control side for Claude Code.
 *
 * The work is done by the ACP control; this only says which adapter to run and how to shape
 * its permissions.
 */
export function claudeCodeControl(options: ClaudeCodeControlOptions): ClaudeCodeSessionControl {
  const command = options.command ?? defaultCommand();
  const harness = HarnessIdSchema.parse(options.harness);

  const control: ClaudeAcpSessionControl = claudeAcpControl({
    harness: options.harness,
    command,
    model: options.model,
    effort: options.effort,
    executable: () => options.executable ?? localClaude(),
    mode: options.mode,
    // Claude Code refuses to start inside another Claude Code session, and niwa is run by one.
    unsetEnv: ["CLAUDECODE"],
    claude: options.claude,
    callTimeoutMs: options.callTimeoutMs,
    turnTimeoutMs: options.turnTimeoutMs,
    stopGraceMs: options.stopGraceMs,
    permissions: toClaudeAcpPermissions(options.permissions),
  });

  return {
    start: async (startOptions: StartOptions): Promise<StartedSession> => {
      requireLaunch(harness, CLAUDE_CODE_LAUNCH, {
        model: startOptions.model ?? options.model,
        effort: startOptions.effort ?? options.effort,
        mode: modeOf(startOptions.mode, options.mode, CLAUDE_CODE_LAUNCH),
      });
      return await control.start(startOptions);
    },
    resume: (id: SessionId, resumeOptions?: ResumeOptions): Promise<void> =>
      control.resume(id, resumeOptions),
    send: (id: SessionId, message: string, sendOptions?: SendOptions): Promise<DeliveryReceipt> =>
      control.send(id, message, sendOptions),
    interrupt: (id: SessionId): Promise<void> => control.interrupt(id),
    ask: <T>(id: SessionId, askOptions: AskOptions<T>): Promise<AskAnswer<T>> =>
      control.ask(id, askOptions),
    life: (id: SessionId): AsyncIterable<LifeEvent> => control.life(id),
    state: (id: SessionId): Promise<SessionState> => control.state(id),
    stop: (id: SessionId): Promise<void> => control.stop(id),
    dispose: (): Promise<void> => control.dispose(),
  };
}

/**
 * Turn Claude Code's permission policy into the ACP one.
 *
 * The ACP protocol names the option the agent offers, so the policy's decision is expressed as
 * "allow" or "deny" and the adapter picks the option the agent actually offered.
 */
function toClaudeAcpPermissions(policy: PermissionPolicy | undefined): ClaudeAcpPermissionPolicy {
  const chosen: PermissionPolicy = policy ?? "allow";
  if (chosen === "allow") return "allow";
  if (chosen === "deny") return "deny";
  return async (request: ClaudeAcpPermissionRequest): Promise<ClaudeAcpPermissionDecision> => {
    const decision = await chosen({
      tool: request.tool ?? request.title ?? "tool",
      input: request.input,
      toolUseId: request.toolCallId,
    });
    return decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: decision.message };
  };
}
