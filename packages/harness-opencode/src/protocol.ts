/**
 * What the control side does with each event of the opencode server: a pure map from an event of
 * the typed client (`@opencode/client`, pinned exactly: the protocol snapshot) to an action, with
 * no process and no client in it. Every event type of the union is a case of an exhaustive
 * `switch`: one the client gains does not compile until someone decides what niwa does with it.
 *
 * The turn is seen by the `session.execution.*` events alone: `session.status` only mirrors them
 * (and flaps through `retry` while an execution still stands), so it is ignored. The stream deltas
 * (`session.text.delta`, `session.reasoning.delta`, `session.tool.input.delta`) are the tokens of a
 * turn in flight, not signs a driver needs; the ended events say what they came to.
 */

import { ProtocolNameSchema } from "@niwa-labs/harness";
import type { ProtocolName } from "@niwa-labs/harness";
import type { EventSubscribeOutput, FormCreated, PermissionAsked, SessionStructuredError, V2EventRpc } from "@opencode/client";

/** The wire protocol of an opencode session, in niwa's own words. */
export const OPENCODE_PROTOCOL: ProtocolName = ProtocolNameSchema.parse("opencode server v2");

/** One event of the server, as the typed client yields it. */
export type ServerEvent = EventSubscribeOutput;

/** What a permission request carries, the part of it niwa answers. */
export type PermissionAskedData = PermissionAsked["data"];
export type OpenCodeForm = FormCreated["data"]["form"];

/** How a turn ended, as far as the execution event says. The answer's text is not in it. */
export interface TurnEnd {
  readonly outcome: "completed" | "failed";
  /** Why a failed turn failed, in the server's own words. */
  readonly error?: string;
}

/** The names of a session's tool calls, learned from the events that name them. */
export interface ToolNames {
  /** The name of a tool call by its id, when an event has named it. */
  nameOf(id: string): string | undefined;
  /** What a later event of the same call can use to say the tool's name. */
  remember(id: string, name: string): void;
}

/** What the control side does with an event of the server. */
export type EventAction =
  /** The turn is over. */
  | { readonly do: "end-turn"; readonly end: TurnEnd }
  /** An execution began: the session is busy, whatever this side believed. */
  | { readonly do: "start-busy" }
  /** A tool asks leave; the answer goes back through `permission.reply`. */
  | { readonly do: "permission"; readonly request: PermissionAskedData }
  | { readonly do: "form"; readonly form: OpenCodeForm }
  | { readonly do: "reverse-ended"; readonly kind: "permission" | "form"; readonly id: string }
  /**
   * A sign of life, told in the session's log by `detail`: the tool it is a call of, when one is
   * known, and the model a step runs, when the event named one (niwa reports it once, and never
   * the model it chose itself).
   */
  | { readonly do: "activity"; readonly detail: string; readonly tool?: string; readonly model?: string }
  /** A type this client does not know: a newer server, degraded to signs. */
  | { readonly do: "unknown"; readonly variant: string }
  /** Nothing: it means nothing to a session's driver. */
  | { readonly do: "ignore" };

/** The words of a structured error of the server, as one line. */
function errorOf(error: SessionStructuredError | undefined, fallback: string): string {
  if (error === undefined) return fallback;
  return error.message === "" ? `${error.type} (no message)` : `${error.type}: ${error.message}`;
}

/** What one event of the server comes to. `names` is the session's tool-call names, read and written. */
export function eventAction(ev: ServerEvent, names: ToolNames): EventAction {
  switch (ev.type) {
    // -- the turn ----------------------------------------------------------
    case "session.execution.succeeded":
      return { do: "end-turn", end: { outcome: "completed" } };
    case "session.execution.failed":
      return { do: "end-turn", end: { outcome: "failed", error: errorOf(ev.data.error, "the turn failed") } };
    case "session.execution.interrupted":
      // A stopped turn did not complete: whoever waited for its answer must hear that it was cut.
      return { do: "end-turn", end: { outcome: "failed", error: `the turn was interrupted (${ev.data.reason})` } };
    case "session.execution.started":
      return { do: "start-busy" };

    // -- the permissions ---------------------------------------------------
    case "permission.asked":
      return { do: "permission", request: ev.data };
    case "permission.replied":
      return { do: "reverse-ended", kind: "permission", id: ev.data.requestID };
    case "form.created":
      return { do: "form", form: ev.data.form };
    case "form.replied":
    case "form.cancelled":
      return { do: "reverse-ended", kind: "form", id: ev.data.id };

    // -- the signs of life -------------------------------------------------
    case "session.step.started":
      return {
        do: "activity",
        detail: `a step began (${ev.data.agent})`,
        model: `${ev.data.model.providerID}/${ev.data.model.id}`,
      };
    case "session.step.first-token":
      return { do: "activity", detail: "the model's first token came" };
    case "session.step.streamed":
      return { do: "activity", detail: "a step streamed" };
    case "session.step.ended":
      return { do: "activity", detail: `a step ended (${ev.data.finish})` };
    case "session.step.failed":
      return { do: "activity", detail: `a step failed: ${errorOf(ev.data.error, "no reason given")}` };
    case "session.text.started":
      return { do: "activity", detail: "a text began" };
    case "session.reasoning.started":
      return { do: "activity", detail: "a reasoning began" };
    case "session.tool.input.started":
      // The only event that names the tool of a call; the calls, the runs and the results name
      // only the call's id, so the name is kept for them.
      names.remember(ev.data.id, ev.data.name);
      return { do: "activity", detail: `the tool ${ev.data.name} was called`, tool: ev.data.name };
    case "session.tool.input.ended":
      return { do: "activity", detail: `the tool ${names.nameOf(ev.data.id) ?? ev.data.id} was given its input`, tool: names.nameOf(ev.data.id) };
    case "session.tool.called":
      return { do: "activity", detail: `the tool ${names.nameOf(ev.data.id) ?? ev.data.id} ran`, tool: names.nameOf(ev.data.id) };
    case "session.tool.progress":
      return { do: "activity", detail: `the tool ${names.nameOf(ev.data.id) ?? ev.data.id} made progress`, tool: names.nameOf(ev.data.id) };
    case "session.tool.success":
      return { do: "activity", detail: `the tool ${names.nameOf(ev.data.id) ?? ev.data.id} succeeded`, tool: names.nameOf(ev.data.id) };
    case "session.tool.failed":
      return { do: "activity", detail: `the tool ${names.nameOf(ev.data.id) ?? ev.data.id} failed: ${errorOf(ev.data.error, "no reason given")}`, tool: names.nameOf(ev.data.id) };
    case "session.inbox.delivered":
      return { do: "activity", detail: "a queued message was taken into a turn" };

    // -- the bookkeeping of the server's own state -------------------------
    // First delivery on a fresh subscription: the hello of the stream.
    case "server.connected":
    // Mirrors the execution events (and flaps through `retry` while an execution stands).
    case "session.status":
    // An execution that ran out of nothing stands; the retry event only announces its next try.
    case "session.idle":
    case "session.retry.scheduled":
    // niwa's own queue is what niwa shows: the inbox echo says what this side already knows.
    case "session.inbox.enqueued":
    case "session.inbox.cancelled":
    case "session.inbox.delivery.changed":
    // The tokens of a turn in flight, not signs a driver needs.
    case "session.text.delta":
    case "session.text.ended":
    case "session.reasoning.delta":
    case "session.reasoning.ended":
    case "session.tool.input.delta":
    // A session's own records: created by the create, read by the reading side.
    case "session.created":
    case "session.deleted":
    case "session.forked":
    case "session.archived":
    case "session.unarchived":
    case "session.renamed":
    case "session.moved":
    case "session.viewed":
    case "session.metadata.updated":
    case "session.permissions":
    case "session.instructions.updated":
    case "session.agent.selected":
    case "session.model.selected":
    case "session.usage.updated":
    // Compaction, reverts, shells, skills and synthetic messages: housekeeping of a turn's record.
    case "session.compaction.started":
    case "session.compaction.delta":
    case "session.compaction.ended":
    case "session.compaction.failed":
    case "session.revert.staged":
    case "session.revert.cleared":
    case "session.revert.committed":
    case "session.shell.started":
    case "session.shell.ended":
    case "session.skill.activated":
    case "session.synthetic":
    // The server's own catalogues, connections and terminals.
    case "agent.updated":
    case "artifact.updated":
    case "command.updated":
    case "config.updated":
    case "credential.updated":
    case "credential.switched":
    case "filesystem.changed":
    case "installation.updated":
    case "installation.update-available":
    case "integration.updated":
    case "location.shutdown":
    case "mcp.status.changed":
    case "mcp.resources.changed":
    case "experimental.mcp.event":
    case "model.updated":
    case "models-dev.refreshed":
    case "plugin.updated":
    case "project.updated":
    case "provider.updated":
    case "pty.created":
    case "pty.updated":
    case "pty.exited":
    case "pty.deleted":
    case "persistent-pty.added":
    case "persistent-pty.removed":
    case "persistent-pty.updated":
    case "reference.updated":
    case "shell.created":
    case "shell.exited":
    case "shell.deleted":
    case "skill.updated":
    case "tui.prompt.append":
    case "tui.command.execute":
    case "tui.session.select":
    case "tui.toast.show":
    case "vcs.branch.updated":
    case "websearch.updated":
    case "worktree.updated":
    case "worktree.resolved":
      return { do: "ignore" };
    default: {
      // The typed remainder of the union is the `rpc.*` family, which the assignment below
      // proves: a case missing above does not compile. At runtime a newer server may still emit a
      // type this client does not know, and such an object falls out of the union here.
      const rpc: V2EventRpc = ev;
      return typeof rpc.type === "string" && rpc.type.startsWith("rpc.")
        ? // An rpc event of a plugin: known shape, opaque payload, nothing niwa does with it.
          { do: "ignore" }
        : { do: "unknown", variant: String((ev as { readonly type?: unknown }).type ?? "?") };
    }
  }
}
