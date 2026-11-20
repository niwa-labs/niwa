/**
 * The ids niwa issues.
 *
 * An id of an instance is `<prefix>-<6..8 hex digits of a hash>`: short enough to type, built from
 * the operation or the record the entity is born in, so a replayed step issues the same id and the
 * caller never chooses one. The prefix says the kind; the kinds and their prefixes are the one
 * registry below.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { UnknownId } from "./errors.ts";
import { resolveId } from "./short-id.ts";
import type { OperationId, RecordId } from "./types.ts";

/** What each kind of entity is called in an id. A prefix is the id of its kind: no two kinds share one. */
export const ID_PREFIXES = {
  run: "run",
  request: "req",
  session: "s",
  task: "task",
  message: "msg",
  subscription: "sub",
  workflow: "wf",
  invocation: "inv",
  note: "note",
  commitment: "com",
  grant: "grant",
  firing: "fire",
  decision: "dec",
  worktree: "wt",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** The id of one kind: `task-3fa9c2`. Branded, so an id of one kind is not accepted for another. */
export type Id<K extends IdKind> = string & { readonly __idKind: K };

/** Shortest and longest hash an id carries, in hex digits. */
export const ID_HASH_MIN = 6;
export const ID_HASH_MAX = 8;

/**
 * What an id is born from: the identity of the journal record of the creating call, never its content.
 * The operation of a step, or the record a host write made: two identical calls are two records and get
 * two ids, and a replayed step finds the same record and gets the same id.
 */
export type IdSeed = OperationId | RecordId;

const KINDS = Object.keys(ID_PREFIXES) as IdKind[];

/** The pattern an id of a kind has. */
function patternOf(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}-[0-9a-f]{${String(ID_HASH_MIN)},${String(ID_HASH_MAX)}}$`);
}

/** The schema of an id of one kind: only the issued format passes. */
export function idSchema<K extends IdKind>(kind: K): z.ZodType<Id<K>, string> {
  return z
    .string()
    .regex(patternOf(kind), `an id of a ${kind}: ${ID_PREFIXES[kind]}-<${String(ID_HASH_MIN)}..${String(ID_HASH_MAX)} hex digits>`)
    // The pattern is what makes the text an id of the kind; the guard only tells the type checker so.
    .refine((text): text is Id<K> => true);
}

/** The hash an id of a kind is cut from: the kind goes in, so one seed gives different ids to different kinds. */
function hashOf(kind: IdKind, seed: string): string {
  return createHash("sha256").update(`${kind}\0${seed}`).digest("hex");
}

/** An id that already exists, and the seed it was issued from. */
export interface IssuedId {
  readonly id: string;
  readonly seed: string;
}

/**
 * The id a seed gets among the ids of its kind that exist.
 *
 * A seed that has an id already gets it again, so a replayed step issues what it issued first. A new
 * seed gets the shortest cut of its hash, from six digits to eight, that no other seed holds; when
 * all three clash, it is an error, because lengthening further would leave the format. Which seed
 * takes the short id is the order the ids were issued in, and that order is the journal's.
 */
export function issueId<K extends IdKind>(kind: K, seed: IdSeed, existing: readonly IssuedId[]): Id<K> {
  const issued = existing.find((entry) => entry.seed === seed);
  if (issued !== undefined) return idSchema(kind).parse(issued.id);
  const hash = hashOf(kind, seed);
  const taken = new Set(existing.map((entry) => entry.id));
  for (let length = ID_HASH_MIN; length <= ID_HASH_MAX; length += 1) {
    const candidate = `${ID_PREFIXES[kind]}-${hash.slice(0, length)}`;
    if (!taken.has(candidate)) return idSchema(kind).parse(candidate);
  }
  throw new Error(`no free ${kind} id for "${seed}": all ${String(ID_HASH_MAX - ID_HASH_MIN + 1)} lengths of its hash are held`);
}

/** What a kind tells the registry: every id of the kind that exists, and the seed each was issued from. */
export type IdSource = () => readonly IssuedId[];

/**
 * The ids of one kind, as a plugin sees them: issue a new one, and resolve what a person typed.
 *
 * What it knows is what its source says, read at each call, so it never holds a stale list.
 */
export class IdIndex<K extends IdKind> {
  constructor(
    readonly kind: K,
    private readonly source: IdSource,
  ) {}

  /** The id the seed gets (see `issueId`). */
  issue(seed: IdSeed): Id<K> {
    return issueId(this.kind, seed, this.source());
  }

  /** Every id of the kind, among the ones `sees` accepts (all by default). */
  ids(sees: (id: string) => boolean = () => true): Id<K>[] {
    const schema = idSchema(this.kind);
    return this.source()
      .map((entry) => schema.parse(entry.id))
      .filter(sees);
  }

  /**
   * The one id a text names: the id, a unique prefix or suffix of it, or its short form among the ids
   * `sees` accepts. Undefined when it names none; `AmbiguousId`, listing the candidates, when it names several.
   */
  resolve(text: string, sees: (id: string) => boolean = () => true): Id<K> | undefined {
    const named = resolveId(text, this.ids(sees), this.kind);
    return named === undefined ? undefined : idSchema(this.kind).parse(named);
  }

  /** The same, but a text that names none is `UnknownId`: what `get` wants. */
  require(text: string, sees: (id: string) => boolean = () => true): Id<K> {
    const named = this.resolve(text, sees);
    if (named === undefined) throw new UnknownId(text, this.kind);
    return named;
  }
}

/** The kinds that have registered their ids, so a text can be resolved by the kind its prefix names. */
export class IdRegistry {
  private readonly indexes = new Map<IdKind, IdIndex<IdKind>>();

  /** A kind registers its source once; a second registration is a mistake. */
  register<K extends IdKind>(kind: K, source: IdSource): IdIndex<K> {
    if (this.indexes.has(kind)) throw new Error(`the ids of a ${kind} are registered already`);
    const index = new IdIndex(kind, source);
    this.indexes.set(kind, index);
    return index;
  }

  /** The index of a registered kind. */
  of<K extends IdKind>(kind: K): IdIndex<K> {
    const index = this.indexes.get(kind);
    if (index === undefined) throw new Error(`the ids of a ${kind} are not registered`);
    return index as IdIndex<K>;
  }

  /**
   * The id a text names when it says its kind by its prefix (`task-3f`) and that kind is registered; the
   * kind of a text that has no registered prefix is not guessed.
   */
  resolve(text: string): { kind: IdKind; id: string } | undefined {
    const [prefix] = text.split("-");
    const kind = KINDS.find((candidate) => ID_PREFIXES[candidate] === prefix && this.indexes.has(candidate));
    const id = kind === undefined ? undefined : this.indexes.get(kind)?.resolve(text);
    return kind === undefined || id === undefined ? undefined : { kind, id };
  }
}
