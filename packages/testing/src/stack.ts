/**
 * The base stack: the plugins nearly every check needs, in the order a host takes them.
 *
 * messages, requests, tasks, timers and sessions over a fake harness. Every factory is called
 * with its defaults, so a check that wants another option builds that plugin itself and uses the
 * rest of the stack by name.
 */

import type { Plugin } from "@niwa-labs/plugin";
import { messages } from "@niwa-labs/messages";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import type { HarnessBinding } from "@niwa-labs/sessions";
import { tasks } from "@niwa-labs/tasks";
import { timers } from "@niwa-labs/timer";

import { fakeHarness } from "./fake-harness.ts";
import type { FakeHarness } from "./fake-harness.ts";

/** What the stack is made with. */
export interface BaseStackOptions {
  /** The harnesses the sessions module serves; by default one fake harness. */
  readonly harnesses?: readonly HarnessBinding[];
}

/** The base stack, and the fake harness it serves when no harnesses were given. */
export interface BaseStack {
  readonly plugins: readonly Plugin[];
  /** The fake harness of the default stack; undefined when the check gave its own harnesses. */
  readonly fake: FakeHarness | undefined;
}

/**
 * The plugins of the base stack: `host.use(...stack.plugins)`.
 *
 * A host with no plugin has no actions but the core's; this is the smallest host that can take
 * a message, a request or a task, run a timer and start a session.
 */
export function baseStack(options: BaseStackOptions = {}): BaseStack {
  const fake = options.harnesses === undefined ? fakeHarness() : undefined;
  const harnesses = options.harnesses ?? (fake === undefined ? [] : [fake.binding]);
  return {
    plugins: [messages(), requests(), tasks(), timers([]), sessions({ harnesses })],
    fake,
  };
}
