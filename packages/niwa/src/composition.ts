/**
 * composition.ts — the default composition: the plugins most hosts run, in the order they are installed.
 *
 * A composition file may export `defaultComposition({ ... })` as it is, or take it and add to it. The
 * order matters: a plugin that offers a built-in workflow or declares the record types one starts on is
 * installed before the workflow module that reads them, and the agents module after sessions, whose
 * binding it wraps so that an agent's sessions speak as the agent.
 */

import { agents as agentsModule } from "@niwa-labs/agent";
import type { AgentOptions } from "@niwa-labs/agent";
import { git } from "@niwa-labs/git";
import type { GitOptions } from "@niwa-labs/git";
import type { HarnessInstanceRegistry } from "@niwa-labs/harness";
import { history } from "@niwa-labs/history";
import { messages } from "@niwa-labs/messages";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import { requests } from "@niwa-labs/requests";
import { insertPlugin, sessions } from "@niwa-labs/sessions";
import { tasks } from "@niwa-labs/tasks";
import { timers } from "@niwa-labs/timer";
import { workflow } from "@niwa-labs/workflow";
import type { WorkflowOptions } from "@niwa-labs/workflow";

import { NIWA_CLI } from "./inserts.ts";

/** What the default composition is made with. */
export interface DefaultCompositionOptions {
  /** The home of the host: the niwa MCP server of a session connects to it. */
  readonly home: string;
  /**
   * The harness installations, each bound by its kind to its own options (`claudeCodeKind.bind({ id:
   * "claude-haiku", model: "haiku" })`): sessions start on them and history reads each in its own home.
   */
  readonly harnesses: HarnessInstanceRegistry;
  /** The agents of the host, the harness of each role and the default agent of `niwa agent attach`. */
  readonly agents?: AgentOptions;
  readonly git?: GitOptions;
  readonly workflow?: WorkflowOptions;
  /**
   * Wraps the binding of callers to addresses that messages, requests and tasks are given: the sessions'
   * binding under the agents'. A surface that speaks for the owner gives its own here
   * (`(fallback) => surface.bind(fallback)`), so that what it does is the owner's.
   */
  readonly bind?: (fallback: CallerBinding) => CallerBinding;
}

/**
 * The plugins of the default composition: messages, requests, tasks, timers, git, history, the inserts'
 * reports (so a harness can say a session ended), sessions, the agents module and workflow.
 */
export function defaultComposition(options: DefaultCompositionOptions): Plugin[] {
  const made = sessions({
    harnesses: options.harnesses,
    niwaMcp: { command: process.execPath, args: [NIWA_CLI, "--home", options.home, "mcp"] },
  });
  const agents = agentsModule(options.agents);
  const bound = agents.bind(made.bind());
  const bind = options.bind === undefined ? bound : options.bind(bound);
  return [
    messages({ bind }),
    requests({ bind }),
    tasks({ messages: { bind } }),
    timers([]),
    git(options.git),
    history({ harnesses: options.harnesses }),
    insertPlugin(),
    made,
    agents,
    workflow(options.workflow),
  ];
}
