/**
 * The state of a request, folded from the journal, and the rules about who may do what to it.
 * The records are the truth; what is held in memory is a reading of them. The first end of a request stands; a
 * later answer, cancel or expiry of the same request is passed over.
 */

import { z } from "zod";

import { CORE_TYPES, CatchableError, IdIndex, UnknownId, answerMismatch, seq, stableJson } from "@niwa-labs/core";
import type { CallerBinding } from "@niwa-labs/plugin";
import type { Answer, IssuedId, JournalReader, RecordId, RecordTypeName, Seq, StoredRecord, Address } from "@niwa-labs/core";

import {
  RequestAnswered,
  RequestCancelledRecord,
  RequestCreated,
  RequestExpiredRecord,
} from "./records.ts";
import { RequestId } from "./records.ts";
import { heldAnswerCheckOf } from "./question.ts";

/** What is read from a record: its type and its data. */
export type Fact = Pick<StoredRecord, "type" | "data"> & Partial<Pick<StoredRecord, "actor">>;

/** A request as it was created. */
export type Created = z.infer<typeof RequestCreated.schema>;

/** What a request is now. An end says who ended it, when the caller was bound to an address. */
export type RequestState =
  | { readonly status: "open"; readonly created: Created }
  | { readonly status: "answered"; readonly created: Created; readonly answer: Answer; readonly by?: Address }
  | { readonly status: "cancelled"; readonly created: Created; readonly by?: Address }
  | { readonly status: "expired"; readonly created: Created };

/** A refusal: a command that breaks a rule. */
export class RequestRefusal extends Error {
  override name = "RequestRefusal";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The request was cancelled: nobody chose to answer it any more.
 *
 * The one waiting catches it and decides what happens next; the wait ends, and the request is
 * not open any more.
 */
export class RequestCancelled extends CatchableError {
  override name = "RequestCancelled";
  override readonly code = "RequestCancelled";
  /** The request that was cancelled. */
  readonly request: RequestId;

  constructor(request: RequestId, message = `the request "${request}" was cancelled`) {
    super(message);
    this.request = request;
  }
}

/**
 * The request expired: the time ran out and nobody answered.
 *
 * The one waiting catches it and decides what happens next; the wait ends, and the request is
 * not open any more.
 */
export class RequestExpired extends CatchableError {
  override name = "RequestExpired";
  override readonly code = "RequestExpired";
  /** The request that expired. */
  readonly request: RequestId;

  constructor(request: RequestId, message = `the request "${request}" expired`) {
    super(message);
    this.request = request;
  }
}

/** The state of every request, in the order the facts happened. */
export function fold(facts: readonly Fact[], bind?: CallerBinding): Map<RequestId, RequestState> {
  const states = new Map<RequestId, RequestState>();
  for (const fact of facts) applyFact(states, fact, bind);
  return states;
}

/** Whether the authenticated writer can speak for the owner. */
export function operatorAnswered(fact: Fact, bind?: CallerBinding): boolean {
  const who = fact.actor;
  if (who === undefined || who.kind === "host") return false;
  if (who.kind === "client") return who.principal?.kind === "owner";
  // A handler is installed host code. Its binding certifies the owner on a running host;
  // offline readers have its host-stamped actor and the binding recorded by the action.
  return bind === undefined ? RequestAnswered.schema.safeParse(fact.data).data?.by?.kind === "owner" : bind(who)?.kind === "owner";
}

/** Apply a birth or the first accepted end of an open request. */
function applyFact(states: Map<RequestId, RequestState>, fact: Fact, bind?: CallerBinding): Created | undefined {
  if (fact.type === RequestCreated.name) {
    const created = RequestCreated.schema.safeParse(fact.data);
    if (!created.success || states.has(created.data.id)) return undefined;
    states.set(created.data.id, { status: "open", created: created.data });
    return created.data;
  }
  const end = endOf(fact);
  if (end === undefined) return undefined;
  const state = states.get(end.id);
  if (state === undefined || state.status !== "open") return undefined;
  if (state.created.answerPolicy === "owner-only" && fact.type === RequestAnswered.name && !operatorAnswered(fact, bind)) return undefined;
  states.set(end.id, end.close(state.created));
  return undefined;
}

/**
 * The requests and the paused invocations as of the last record read, kept between calls.
 *
 * The journal is the truth; this is a reading of it that goes on from where it stopped, so an
 * answer does not fold the whole history again. A journal that is not the one it read starts it
 * over.
 */
export class RequestLedger {
  private readonly states = new Map<RequestId, RequestState>();
  private readonly latest = new Map<string, z.infer<typeof InvocationState>>();
  /** Each request id with the journal record it was born in: what a replayed ask is found by. */
  private readonly issued = new Map<RequestId, IssuedId>();
  private cursor: Seq = seq(0);
  private source: JournalReader | undefined;
  /** The ids of the requests: issues a new one, and resolves what a person typed. */
  readonly ids: IdIndex<"request">;

  constructor(
    private readonly types: RecordTypeName[],
    private readonly reader: () => JournalReader | undefined,
    private readonly bind?: CallerBinding,
  ) {
    this.ids = new IdIndex("request", () => {
      this.catchUp();
      return [...this.issued.values()];
    });
  }

  /** A record of the journal by its id, when the host is serving and holds it. */
  recordOf(id: RecordId): StoredRecord | undefined {
    return this.reader()?.get(id);
  }

  /** The state of every request, up to the last record of the journal. */
  requests(): ReadonlyMap<RequestId, RequestState> {
    this.catchUp();
    return this.states;
  }

  /**
   * The request a command names: an id, a unique prefix or suffix of one, or the run whose one
   * open ask it is. A whole id of an existing request names that one before any short form is tried. A text that names no request but is an id is said as an id, so a request the
   * caller may not act on is refused for that and not for being unknown.
   */
  named(input: { id?: string | undefined; run?: string | undefined }, sees: (request: Created) => boolean = () => true): RequestId {
    if (input.id !== undefined) {
      // The whole id of a request names it, open or ended: a longer id that starts with the same text
      // is another request. Whether the caller may act on it is for the command to decide.
      const whole = RequestId.safeParse(input.id);
      if (whole.success && this.requests().has(whole.data)) return whole.data;
    }
    // Only the requests the caller may act on are candidates: a short text never names, or lists in a refusal, another's.
    const states = [...this.requests().values()].filter((state) => sees(state.created));
    if (input.id !== undefined) {
      // What is open is looked at first: a text that names one open request is that one, though it also ends an old one.
      const open = new Set(states.filter((state) => state.status === "open").map((state) => state.created.id));
      const seen = new Set(states.map((state) => state.created.id));
      const named = this.ids.resolve(input.id, (id) => open.has(RequestId.parse(id))) ?? this.ids.resolve(input.id, (id) => seen.has(RequestId.parse(id)));
      if (named !== undefined) return named;
      const exact = RequestId.safeParse(input.id);
      if (exact.success) return exact.data;
      throw new RequestRefusal("unknown", `the request "${input.id}" does not exist`);
    }
    const run = input.run ?? "";
    const asks = states.filter((state) => state.status === "open" && state.created.from?.kind === "client" && state.created.from.id.startsWith(`run:${run}`)).map((state) => state.created.id);
    const [only, ...more] = asks;
    if (only === undefined) throw new RequestRefusal("no-open-ask", `the run "${run}" has no open ask`);
    if (more.length > 0) throw new RequestRefusal("several-asks", `the run "${run}" has ${String(asks.length)} open asks: ${asks.join(", ")}: name one`);
    return only;
  }

  /** The request a text names: an id, a unique prefix or suffix of one. A text that names none is `UnknownId`. */
  get(text: string): RequestState {
    const state = this.requests().get(this.ids.require(text));
    if (state === undefined) throw new UnknownId(text, "request");
    return state;
  }

  /** The invocations whose latest state is "paused", up to the last record of the journal. */
  paused(): Paused[] {
    this.catchUp();
    return pausedIn(this.latest.values());
  }

  private catchUp(): void {
    const journal = this.reader();
    if (journal === undefined) return;
    if (journal !== this.source) {
      this.source = journal;
      this.states.clear();
      this.issued.clear();
      this.latest.clear();
      this.cursor = seq(0);
    }
    for (const record of journal.since(this.cursor, [...this.types, CORE_TYPES.invocationState])) {
      this.cursor = record.seq;
      if (record.type === CORE_TYPES.invocationState) {
        const data = InvocationState.safeParse(record.data);
        if (data.success) this.latest.set(data.data.invocation, data.data);
      } else {
        const created = applyFact(this.states, record, this.bind);
        if (created !== undefined) this.issued.set(created.id, { id: created.id, seed: record.id });
      }
    }
  }
}

/** The request a fact ends, and the state it leaves the request in. */
function endOf(
  fact: Fact,
): { id: RequestId; close: (created: Created) => RequestState } | undefined {
  if (fact.type === RequestAnswered.name) {
    const data = RequestAnswered.schema.safeParse(fact.data);
    if (!data.success) return undefined;
    const { id, answer, by } = data.data;
    return { id, close: (created) => ({ status: "answered", created, answer, ...(by === undefined ? {} : { by }) }) };
  }
  if (fact.type === RequestCancelledRecord.name) {
    const data = RequestCancelledRecord.schema.safeParse(fact.data);
    if (!data.success) return undefined;
    const { id, by } = data.data;
    return { id, close: (created) => ({ status: "cancelled", created, ...(by === undefined ? {} : { by }) }) };
  }
  if (fact.type === RequestExpiredRecord.name) {
    const data = RequestExpiredRecord.schema.safeParse(fact.data);
    if (!data.success) return undefined;
    return { id: data.data.id, close: (created) => ({ status: "expired", created }) };
  }
  return undefined;
}

/**
 * The request of this question that a record caused: what a handler woken by the record asked. How a
 * handler finds its own request again: a caller does not choose the id of one.
 */
export function requestOfCause(journal: JournalReader, cause: RecordId, question: string): RequestId | undefined {
  for (const stored of journal.find({ type: RequestCreated.name })) {
    if (stored.cause !== cause) continue;
    const created = RequestCreated.schema.safeParse(stored.data);
    if (created.success && created.data.question === question) return created.data.id;
  }
  return undefined;
}

/** Are two addresses the same one? They are when they say the same thing, kind included. */
export function sameAddress(one: Address, other: Address): boolean {
  return stableJson(one) === stableJson(other);
}

/**
 * What an answer does to the state of a request.
 *
 * - "write": the answer is written and the request is answered by it.
 * - "repeat": the same address gave the same answer to a request that is already answered by
 *   it; nothing is written and the answer stands.
 * - "late": the request was cancelled or expired before the answer came; nothing is written and
 *   the answerer is told why, not refused.
 */
export type AnswerVerdict =
  | { readonly kind: "write" }
  | { readonly kind: "repeat" }
  | { readonly kind: "late"; readonly reason: "cancelled" | "expired" };

/**
 * What an answer does. Only the addressee answers an open request, once; the same address
 * giving the same answer again changes nothing ("repeat"), and anything else is refused.
 *
 * An answer to a request that was cancelled or expired does nothing ("late"): the request is
 * over, and the answerer is told so instead of being refused.
 *
 * The answer is checked against the schema of the question when it comes. An answer that does
 * not pass it is refused, and nothing is written: the request stays open, and a right answer
 * may still come.
 */
export function decideAnswer(
  id: RequestId,
  state: RequestState | undefined,
  by: Address | undefined,
  answer: Answer,
): AnswerVerdict {
  if (by === undefined) {
    throw new RequestRefusal("unbound", "the caller is not bound to an address, so it cannot answer");
  }
  if (
    state?.status === "answered" &&
    state.by !== undefined &&
    sameAddress(by, state.by) &&
    stableJson(answer) === stableJson(state.answer)
  ) {
    return { kind: "repeat" };
  }
  if (state?.status === "cancelled") return { kind: "late", reason: "cancelled" };
  if (state?.status === "expired") return { kind: "late", reason: "expired" };
  const open = requireOpen(id, state);
  if (!sameAddress(by, open.to)) {
    throw new RequestRefusal("not-addressee", `only the addressee of the request "${id}" may answer it`);
  }
  checkAnswer(open, answer);
  return { kind: "write" };
}

/**
 * The answer must fit the question of the request it answers: its kind says which answers there
 * are, and its options and its schema say which of them. An answer that cancels is no answer:
 * cancelling is what `request.cancel` is for.
 *
 * While the ask waits in this process, the zod schema of the value of its form is held and checks
 * the value whole, refinements included, which JSON Schema cannot say.
 */
export function checkAnswer(request: Pick<Created, "id" | "question" | "input">, answer: Answer): void {
  const mismatch = answerMismatch(request.input, answer);
  if (mismatch !== undefined) {
    throw new RequestRefusal("bad-answer", `the answer to "${request.question}" is not valid: ${mismatch}`);
  }
  const held = heldAnswerCheckOf(request.id);
  if (held === undefined || !("form" in answer)) return;
  const checked = held.safeParse(answer.form);
  if (!checked.success) {
    throw new RequestRefusal("bad-answer", `the answer to "${request.question}" is not valid: ${checked.error.message}`);
  }
}

/**
 * What a cancel does. Only the asker or the addressee cancels an open request; the same
 * address cancelling again changes nothing ("repeat").
 */
export function decideCancel(
  id: RequestId,
  state: RequestState | undefined,
  by: Address | undefined,
): "write" | "repeat" {
  if (by === undefined) {
    throw new RequestRefusal("unbound", "the caller is not bound to an address, so it cannot cancel");
  }
  if (state?.status === "cancelled" && state.by !== undefined && sameAddress(by, state.by)) {
    return "repeat";
  }
  const open = requireOpen(id, state);
  const parties = [open.to, ...(open.from === undefined ? [] : [open.from])];
  if (!parties.some((party) => sameAddress(by, party))) {
    throw new RequestRefusal("not-party", `only the asker or the addressee of the request "${id}" may cancel it`);
  }
  return "write";
}

/** The request, when it is open. */
function requireOpen(id: RequestId, state: RequestState | undefined): Created {
  if (state === undefined) throw new RequestRefusal("unknown", `the request "${id}" does not exist`);
  if (state.status !== "open") {
    throw new RequestRefusal(state.status, `the request "${id}" is already ${state.status}`);
  }
  return state.created;
}

/** The data of a state change of an invocation, as far as the list of open work needs it. */
const InvocationState = z.object({
  invocation: z.string().min(1),
  state: z.string(),
  key: z.string().optional(),
  reason: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

/** An invocation that is paused: it waits for a decision between typed choices. */
export interface Paused {
  readonly invocation: string;
  readonly choices: readonly string[];
  readonly key?: string;
  readonly reason?: string;
}

/** The invocations among these whose state is "paused". */
function pausedIn(latest: Iterable<z.infer<typeof InvocationState>>): Paused[] {
  return [...latest]
    .filter((data) => data.state === "paused")
    .map((data) => ({
      invocation: data.invocation,
      choices: data.choices ?? [],
      ...(data.key === undefined ? {} : { key: data.key }),
      ...(data.reason === undefined ? {} : { reason: data.reason }),
    }));
}
