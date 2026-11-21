/**
 * Actions: something the system can do, declared as a value.
 *
 * An action is a name, a description, two schemas and a body. It is declared once and shows up
 * everywhere at once: as the MCP tool an agent sees, as the CLI command a person runs, and in
 * niwa's own description of itself. The list of actions is the one
 * source for all three; nobody keeps a second list.
 *
 * Declaring an action registers nothing. The host installs it when a plugin declares it, and a
 * handler calls it through a step, where the call is recorded before it happens.
 *
 * Two things are normalized here, because every caller depends on them:
 *
 * - The body may be synchronous or asynchronous; the declared action always returns a promise.
 *   A body that throws throws a rejected promise, so a caller never has to catch two different
 *   shapes of the same failure.
 * - The recovery contract is declared, never assumed. Every action says what may be done after a
 *   call that was cut off, because the safe contract differs per action: a read may be made again,
 *   and an effect that cannot be repeated must say so.
 *
 * The schemas are held, not run. The action does not check its own input or output: the caller
 * checks, because the caller knows what a failure means. A rejected input and a wrong output are
 * different facts for a step.
 */

import type { z } from "zod";
import type {
  Action,
  ActionContext,
  ActionName,
  ActionRef,
  ActionTarget,
  CheckContext,
  CheckResult,
  Effect,
  OperationId,
  Recovery,
  World,
} from "./types.ts";

/**
 * The three recovery contracts of an action.
 *
 * "repeat" is safe to call again;
 * "repeat-with-key" is safe because the other side dedupes by the operation id we pass;
 * "do-not-repeat" means the effect may already have happened, so the step resolves as unknown.
 */
const RECOVERIES: readonly Recovery[] = ["repeat", "repeat-with-key", "do-not-repeat"];

/** The classes of an action's effect, from the one that changes nothing to the one that cannot be undone. */
export const EFFECTS: readonly Effect[] = ["read", "record", "write", "irreversible"];

/** Where the effect of an action may land. */
export const WORLDS: readonly World[] = ["niwa", "local", "external"];

/**
 * The name of an action: how it is called by name, how it is keyed in the registry and how it is
 * seen from outside.
 *
 * A name is a key. It travels through the socket and back into the registry, so it must not be
 * empty, must not contain whitespace, and must not contain the separator of a handler id. The
 * stricter shape a tool name needs on the MCP surface is imposed there, where the name is turned
 * into a tool; here a name is only a key.
 */
export function actionName(value: string): ActionName {
  if (typeof value !== "string") {
    throw new TypeError(`action name must be a string, got ${typeof value}`);
  }
  if (value.trim().length === 0) {
    throw new TypeError("action name must not be empty");
  }
  if (/\s/.test(value)) {
    throw new TypeError(`action name must not contain whitespace: ${JSON.stringify(value)}`);
  }
  if (value.includes("/")) {
    throw new TypeError(
      `action name must not contain "/": ${JSON.stringify(value)}`,
    );
  }
  return value as ActionName;
}

/** What an action is made of. The schemas are held, not run: the caller checks. */
export interface ActionSpec<I, O, In = I> {
  /** What this action does, in a sentence. This is what an agent and a CLI user read. */
  description: string;
  /**
   * The schema of the input.
   *
   * `I` is what it produces and `In` is what it accepts: a caller passes what the schema takes,
   * and the body of the action receives the parsed `I`.
   */
  input: z.ZodType<I, In>;
  /** The schema of the output. */
  output: z.ZodType<O>;
  /**
   * What may be done after a call that was cut off before its outcome was known:
   * "repeat", "repeat-with-key" or "do-not-repeat".
   *
   * Required: every action declares its own contract.
   */
  recovery: Recovery;
  /**
   * What a call changes: "read", "record" (only niwa's own records), "write" or "irreversible".
   *
   * Required: a mask never grants an irreversible action, and a hold refuses writes, so every
   * action says which it is.
   */
  effect: Effect;
  /**
   * The class of one call, when it depends on the input: CI on an ordinary branch is a write, on a
   * protected branch or a tag it cannot be taken back. `effect` is then the most a call can be, and
   * what is described before any call is made.
   *
   * It is asked with the input the call is made with, after the adjusts and before the grant
   * decides; the class it answers is the one the grant matches and the one recorded with the call.
   * It may ask the other side (whether a branch is protected): it may answer a promise. A class
   * above `effect`, or a classifier that throws, refuses the call: nothing ran.
   */
  classify?(input: I): Effect | Promise<Effect>;
  /** Where the effect lands: "niwa", "local" or "external". Absent, the action does not say. */
  world?: World;
  /**
   * Two separate calls with the same input do what one does. Only what the action declares: a
   * retry under the same operation id is one call, and says nothing about two.
   */
  idempotent?: boolean;
  /** The action destroys or overwrites something. An irreversible action always does. */
  destructive?: boolean;
  /** The `@target` of a call, for the rules of a grant that name one. */
  target?(input: I): string | undefined;
  /** The body: what the action actually does. */
  run(input: I, ctx: ActionContext): Promise<O> | O;
  /**
   * What happened to a call that was cut off, asked by its operation id.
   *
   * Optional. When it is there, a cut-off call asks it first: its answer becomes the outcome.
   * It turns unknown into completed or failed, and it never reattaches to live work.
   */
  check?(operationId: OperationId, ctx: CheckContext): Promise<CheckResult<O>>;
}

/**
 * A schema is a schema: something that can check a value. A body that cannot check its input
 * fails at the call, in the middle of an invocation, where the failure is the least clear.
 */
function requireSchema(key: ActionName, what: "input" | "output", schema: unknown): void {
  if (
    schema === null ||
    typeof schema !== "object" ||
    typeof (schema as { parse?: unknown }).parse !== "function"
  ) {
    throw new TypeError(
      `action "${key}": ${what} must be a zod schema, got ${describe(schema)}`,
    );
  }
}

/** A description is read by an agent and by a person: an empty one says nothing. */
function requireDescription(key: ActionName, description: unknown): void {
  if (typeof description !== "string") {
    throw new TypeError(
      `action "${key}": description must be a string, got ${describe(description)}`,
    );
  }
  if (description.trim().length === 0) {
    throw new TypeError(`action "${key}": description must not be empty`);
  }
}

/** A short description of a value that was not what it had to be. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return `${typeof value} (${JSON.stringify(value)})`;
}

/**
 * A declared action: `action("telegram.send", { ... })`.
 *
 * The returned value is the whole declaration. It carries no registration, no state and no
 * closure over the host: an action is installed by a plugin, called by a step and described to
 * the outside world, and it is the same value in all three places.
 *
 * The body may be synchronous or asynchronous; what the caller receives is always a promise. A
 * body that throws is a rejected promise, never a synchronous exception, so the caller has one
 * failure to handle.
 */
export function action<I, O, In = I>(name: string, spec: ActionSpec<I, O, In>): Action<I, O, In>;
/** The same action, built from a typed reference: its description and schemas are the reference's. */
export function action<I, O, In = I>(
  ref: ActionRef<I, O, In>,
  spec: Omit<ActionSpec<I, O, In>, "description" | "input" | "output">,
): Action<I, O, In>;
export function action<I, O, In = I>(
  target: string | ActionRef<I, O, In>,
  rawSpec: ActionSpec<I, O, In> | Omit<ActionSpec<I, O, In>, "description" | "input" | "output">,
): Action<I, O, In> {
  // Built from a reference, the description and the schemas are the reference's own: they are
  // taken from it and cannot be given again, so the two sides cannot drift.
  const key = actionName(typeof target === "string" ? target : target.name);
  if (rawSpec === null || typeof rawSpec !== "object") {
    throw new TypeError(`action "${key}": needs a specification`);
  }
  const spec = (
    typeof target === "string"
      ? rawSpec
      : {
          ...rawSpec,
          description: target.description,
          input: target.input,
          output: target.output,
          ...(target.target === undefined || rawSpec.target !== undefined
            ? {}
            : { target: target.target }),
        }
  ) as ActionSpec<I, O, In>;

  requireDescription(key, spec.description);
  requireSchema(key, "input", spec.input);
  requireSchema(key, "output", spec.output);

  const body = spec.run;
  if (typeof body !== "function") {
    throw new TypeError(
      `action "${key}": run must be a function, got ${describe(body)}`,
    );
  }

  const recovery = spec.recovery;
  if (!RECOVERIES.includes(recovery)) {
    throw new TypeError(
      `action "${key}": recovery must be one of ${RECOVERIES.join(", ")}, got ${describe(
        recovery,
      )}`,
    );
  }

  const effect = spec.effect;
  if (!EFFECTS.includes(effect)) {
    throw new TypeError(`action "${key}": effect must be one of ${EFFECTS.join(", ")}, got ${describe(effect)}`);
  }
  const world = spec.world;
  if (world !== undefined && !WORLDS.includes(world)) {
    throw new TypeError(`action "${key}": world must be one of ${WORLDS.join(", ")}, got ${describe(world)}`);
  }
  for (const flag of ["idempotent", "destructive"] as const) {
    const value = spec[flag];
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`action "${key}": ${flag} must be a boolean, got ${describe(value)}`);
    }
  }
  if (effect === "irreversible" && spec.destructive === false) {
    throw new TypeError(`action "${key}": an irreversible action is destructive`);
  }

  const classify = spec.classify;
  if (classify !== undefined && typeof classify !== "function") {
    throw new TypeError(`action "${key}": classify must be a function, got ${describe(classify)}`);
  }

  const check = spec.check;
  const targetOf = spec.target;
  return {
    kind: "action",
    name: key,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    recovery,
    effect,
    ...(world === undefined ? {} : { world }),
    ...(spec.idempotent === undefined ? {} : { idempotent: spec.idempotent }),
    ...(spec.destructive === undefined ? {} : { destructive: spec.destructive }),
    ...(targetOf === undefined ? {} : { target: targetOf }),
    ...(classify === undefined ? {} : { classify }),
    // The wrapper is what makes the promise total: a synchronous body and a synchronous throw
    // both come out as a promise.
    run: async (input: I, ctx: ActionContext): Promise<O> => body(input, ctx),
    ...(check === undefined
      ? {}
      : {
          check: async (
            operationId: OperationId,
            ctx: CheckContext,
          ): Promise<CheckResult<O>> => check(operationId, ctx),
        }),
  };
}

/** What one call of an action is classed as, or why it cannot be classed. */
export type CallEffect = { readonly effect: Effect } | { readonly refused: string };

/**
 * The class of one call: what the action's `classify` says of this input, held to the class the
 * action declares, which is the most a call of it can be. An action that does not classify its
 * calls gives every call the class it declares.
 */
export async function effectOfCall<I>(action: Pick<Action<I, unknown, any>, "name" | "effect" | "classify">, input: I): Promise<CallEffect> {
  if (action.classify === undefined) return { effect: action.effect };
  let effect: unknown;
  try {
    effect = await action.classify(input);
  } catch (error) {
    return { refused: `the class of this call of "${action.name}" could not be told: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!EFFECTS.includes(effect as Effect)) {
    return { refused: `"${action.name}" classed a call as ${describe(effect)}, which is not one of ${EFFECTS.join(", ")}` };
  }
  if (EFFECTS.indexOf(effect as Effect) > EFFECTS.indexOf(action.effect)) {
    return { refused: `"${action.name}" classed a call as "${String(effect)}", and it declares at most "${action.effect}"` };
  }
  return { effect: effect as Effect };
}

/**
 * The name a target points at: a bare name is itself, a reference or an action carries it.
 */
export function targetName<I, O, In = I>(target: ActionTarget<I, O, In>): ActionName {
  return typeof target === "string" ? target : target.name;
}

/**
 * The action a target holds, when it holds one.
 *
 * An action by value runs as it is. A bare name and a typed reference hold nothing to run: they
 * are looked up by name in the host, which is the only place the real action lives.
 */
export function heldAction<I, O, In = I>(target: ActionTarget<I, O, In>): Action<I, O, In> | undefined {
  if (typeof target === "string") return undefined;
  return "run" in target && typeof target.run === "function"
    ? (target as Action<I, O, In>)
    : undefined;
}

/**
 * A typed reference to an action: its name, description and the two schemas, with no body.
 *
 * It is what a module exports for its callers. The module's factory builds the real action from
 * the same reference, `action(ref, { recovery, run })`, so a client and the host check against one
 * schema and the two cannot drift.
 */
export function actionRef<I, O, In = I>(
  name: string,
  spec: Pick<ActionSpec<I, O, In>, "description" | "input" | "output" | "target">,
): ActionRef<I, O, In> {
  const key = actionName(name);
  requireDescription(key, spec.description);
  requireSchema(key, "input", spec.input);
  requireSchema(key, "output", spec.output);
  return {
    name: key,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    ...(spec.target === undefined ? {} : { target: spec.target }),
  };
}
