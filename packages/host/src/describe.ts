/**
 * describe.ts — niwa's self-description, generated from the registered actions and record types
 *. There is no second list: a plugin that declares an action
 * adds it to the description with no change here.
 *
 * The schemas are rendered as JSON Schema from the same zod schemas the host validates with
 *. A member with no JSON Schema equivalent renders as "anything".
 */

import type {
  Action,
  ActionDescription,
  Description,
  RecordDescription,
  RecordType,
} from "@niwa-labs/core";
import { toJsonSchema } from "@niwa-labs/core";

/** What the description is built from: the registered declarations, not the host. */
export interface Describable {
  actions: Iterable<Action<any, any>>;
  types: Iterable<RecordType<any>>;
}

/** One action, as the description shows it. */
export function describeAction(action: Action<any, any>): ActionDescription {
  return {
    name: action.name,
    description: action.description,
    recovery: action.recovery,
    effect: action.effect,
    ...(action.world === undefined ? {} : { world: action.world }),
    ...(action.idempotent === undefined ? {} : { idempotent: action.idempotent }),
    ...(action.destructive === undefined ? {} : { destructive: action.destructive }),
    input: toJsonSchema(action.input, "input"),
    output: toJsonSchema(action.output, "output"),
  };
}

/** One record type, as the description shows it. */
export function describeRecordType(type: RecordType<any>): RecordDescription {
  return {
    name: type.name,
    version: type.version,
    schema: toJsonSchema(type.schema, "input"),
  };
}

/** The actions and the record types, in the order they were declared. */
export function describe(source: Describable): Description {
  return {
    actions: [...source.actions].map(describeAction),
    types: [...source.types].map(describeRecordType),
  };
}
