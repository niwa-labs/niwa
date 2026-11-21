/**
 * What a plugin offers to the plugins that read it (`api.offer`, `api.offers`): the built-in workflows a plugin ships
 * go to the workflow module, the timers it needs to the timers. The points and the shape of what is offered live here,
 * so the offering plugin imports no reader.
 *
 * Built-in workflows: scripts a plugin ships in its own tree and niwa runs by itself. A plugin offers each one in its setup —
 * `api.offer(BUILTIN_WORKFLOW, { name, file, description, triggers })` — and the workflow module, installed after it,
 * does the rest when the host starts: it registers the file (its code is stored under the home, its version is the hash
 * of its source closure, so a changed file in a new build of niwa is a new version by itself) and installs it on the
 * `on` of the script, under a profile that is exactly its `uses`. A built-in the plugin no longer offers is
 * uninstalled. The pair (plugin, name) finds the same `wf-…` again on every start, so nothing is made twice.
 *
 * The owner does not edit a built-in: registering a file under its id and uninstalling it are refused; it is turned
 * off by the option of the plugin that offers it.
 */

import { z } from "zod";

import type { RecordType } from "@niwa-labs/core";
import { offerKey } from "./plugin.ts";
import type { OfferKey } from "./plugin-types.ts";

/** One built-in workflow, as its plugin offers it. */
export interface BuiltinWorkflow {
  /** Its name among the built-ins of the plugin: with the plugin, what finds it again across restarts. */
  readonly name: string;
  /** The script: an absolute path inside the plugin's own tree. */
  readonly file: string;
  /** A few words on one line: what it is registered and installed under. */
  readonly description: string;
  /**
   * The record types its `on` names, other than the records of scripts: the workflow module starts runs on them as
   * on the `triggers` it is given, so the owner does not list them. A type is given by its name when the plugin that
   * declares it is not one the offering plugin imports (`"timer.fired"`): it must be declared by a plugin installed
   * before the workflow module.
   */
  readonly triggers?: ReadonlyArray<RecordType<any> | string>;
  /**
   * Each new version comes in as a candidate: it is registered, and neither the latest version of the workflow nor its
   * installation moves to it until it is promoted. Before a version was accepted, the candidate is shown and starts on
   * nothing.
   */
  readonly gated?: boolean;
  /** This built-in runs the plugin's trials and may promote their checked versions. */
  readonly suite?: true;
}

/** Where a plugin offers a built-in workflow: `api.offer(BUILTIN_WORKFLOW, { name, file, description, triggers })`. */
export const BUILTIN_WORKFLOW: OfferKey<BuiltinWorkflow> = offerKey("workflow.builtin", "workflow");

/**
 * What a timer does with the dues it missed while the host was down.
 *
 * - "once": one firing for all the missed dues.
 * - "skip": nothing for the missed dues.
 */
export type MissedRule = "once" | "skip";

/** What every timer has, whatever its schedule. */
interface TimerBase {
  /** The id of the timer: the author's name for it, which the firings carry. */
  readonly id: string;
  /** A few words a person reads in a list. Without one, the schedule is the description. */
  readonly description?: string;
  /** What to do with the dues missed while the host was down. Default: "once". */
  readonly missed?: MissedRule;
}

/**
 * One timer: when it fires, and what it does with the dues it missed.
 *
 * A timer has exactly one schedule: a period (`every`), a moment (`at`) or a time of day
 * (`daily`). A timer with none would never fire and a timer with two is not a choice anybody can
 * make, so neither is a definition.
 */
export type TimerDef = TimerBase &
  (
    | {
        /** The period, in milliseconds. The timer fires again every period. */
        readonly every: number;
        readonly at?: never;
        readonly daily?: never;
      }
    | {
        /** The moment, in milliseconds since the epoch. The timer fires once. */
        readonly at: number;
        readonly every?: never;
        readonly daily?: never;
      }
    | {
        /** The time of day, "HH:MM" in local time. The timer fires every day at that time. */
        readonly daily: string;
        readonly every?: never;
        readonly at?: never;
      }
  );

/**
 * A timer as a plugin offers it: the plain definition, or the trigger that carries one (`timer.daily("04:00", { id })`).
 * The data of a firing is what the trigger is a record type of.
 */
export type TimerOffer = TimerDef | { readonly kind: "trigger"; readonly timer: string; readonly def: TimerDef };

/**
 * Where a plugin offers a timer it needs (`api.offer(TIMER_OFFER, { id, daily: "04:00" })`): the timers
 * plugin schedules it with the ones it is given, so the owner does not list it. A timer of the same id in the
 * owner's list is the one that is scheduled.
 */
export const TIMER_OFFER: OfferKey<TimerOffer> = offerKey("timer", "timers");

/**
 * A client module a plugin offers to the cockpit: where its source is on the host. The host lists the
 * modules (`niwa.cockpit.catalog`) with a hash of their code, and the web server builds and serves them to the
 * browser; the plugin never imports the module, so the host process loads no React.
 */
export interface CockpitModuleOffer {
  /** The id of the module, the id of the cockpit plugin it exports: lowercase words joined by `-` or `.`. */
  readonly id: string;
  /** The module's entry: an absolute path to a source file inside the plugin's own tree. */
  readonly entry: string;
  /** Stylesheets the module needs: absolute paths of files inside the plugin's own tree. */
  readonly styles?: readonly string[];
}

/**
 * Where a plugin offers its cockpit module: `api.offer(COCKPIT_MODULE, { id, entry })`. The host itself reads the
 * point, so no plugin has to be installed to read it.
 */
export const COCKPIT_MODULE: OfferKey<CockpitModuleOffer> = offerKey("cockpit.module", "host");

/**
 * An agent as a plugin defines it: the agents module serves it as it serves the agents of its own
 * options. The name is the agent's address (`agent:<name>`); it runs on a harness installation or on a
 * role, is told its prompt and character, and its sessions see the niwa actions of its hands.
 */
interface AgentOfferBase {
  readonly name: string;
  readonly prompt: string;
  readonly character?: string;
  readonly hands?: readonly string[];
  readonly tools?: "all" | "niwa-only" | { readonly allow: readonly string[] };
  readonly project?: { readonly cwd: string; readonly direction?: string };
}

/**
 * An agent runs on exactly one of a harness installation (`harness`) and a role (`role`): an offer with
 * neither would not be an agent and one with both is not a choice anybody can make, so neither is an offer.
 */
export type AgentOffer = AgentOfferBase &
  (
    | { readonly harness: string; readonly role?: never }
    | { readonly role: string; readonly harness?: never }
  );

/** Where a plugin defines an agent it needs (`api.offer(AGENT, { name, harness, prompt })`): the agents module reads it. */
export const AGENT: OfferKey<AgentOffer> = offerKey("agent", "agents");

/**
 * Operations a plugin began outside niwa that have not ended (a merge armed on a forge, a message
 * scheduled elsewhere), as a plugin offers them to whoever reports what a hold of a run leaves
 * behind: a hold stops the run's own writes, but what was begun elsewhere goes on, and the person
 * holding the run should be told.
 *
 * `list` names an action of the offering plugin that reads and takes no input; it answers
 * `{ items }`, each item what the plugin says of one operation, and may carry the action that calls
 * it off (`cancel`, with its input), which the person is shown and the report never runs.
 */
export interface PendingExternal {
  /** What the operations are, for a person reading the hold: "armed merges". */
  readonly label: string;
  /** The name of the action that lists them. */
  readonly list: string;
}

/** The action that calls one pending operation off, as the plugin that lists it says it. */
export const PendingCancelSchema = z.object({ action: z.string().min(1), input: z.record(z.string(), z.unknown()) });

/** One pending operation: what the plugin says of it, and how to call it off when it can be. */
export const PendingExternalItemSchema = z.looseObject({ cancel: PendingCancelSchema.optional() });
export type PendingExternalItem = z.output<typeof PendingExternalItemSchema>;

/** What the listing action of a `PendingExternal` answers. */
export const PendingExternalAnswerSchema = z.object({ items: z.array(PendingExternalItemSchema) });

/**
 * Where a plugin offers the operations it has pending (`api.offer(PENDING_EXTERNAL, { label, list })`).
 * The host reads the point, so no plugin has to be installed for the offer to be served: where nobody
 * reports holds, the offer is not read.
 */
export const PENDING_EXTERNAL: OfferKey<PendingExternal> = offerKey("pending.external", "host");

/**
 * A package a plugin gives scripts: a package of `@niwa-labs` that is installed where the plugin is and not among the
 * packages niwa runs with (`@niwa-labs/forge`, whose `/flow` entry a delivery script imports). The workflow module, when
 * the host has one, reads it once the plugins are installed: a stored copy of a script finds the package by its name as
 * it finds niwa's own, its manifest names it with its version, and a script process in a box may read it. It is offered
 * to the host, so a plugin offers it whether or not the host runs scripts, and in any order.
 */
export interface ScriptPackage {
  /** The name of the package: `@niwa-labs/<name>`. */
  readonly name: string;
  /** The folder of the package, an absolute path: the one whose `package.json` has that name. */
  readonly root: string;
}

/** Where a plugin offers a package to scripts: `api.offer(SCRIPT_PACKAGE, { name, root })`. */
export const SCRIPT_PACKAGE: OfferKey<ScriptPackage> = offerKey("script.package", "host");
