/**
 * The requests module: someone waits for a typed answer from someone.
 *
 * - **request.ask** creates the request and, as a step, waits for the answer in one call, so an
 *   answer cannot arrive between the two and be missed. The wait survives a restart. Called
 *   directly it cannot wait: it returns the id of the open request.
 * - **request.answer** answers a request. The caller is bound to an address by the transport,
 *   never by the payload, and only the addressee may answer. The first answer stands.
 * - **request.cancel** cancels an open request; only its asker or addressee may.
 * - **request.open** lists what waits: open requests, and invocations paused for a decision.
 * - **request.list** and **request.get** read any request, open or ended, by id or short form.
 *
 * The state of a request is folded from the journal (`state.ts`). A plugin may register a
 * resolver to answer a request before it reaches its addressee (`resolver.ts`).
 */

import { z } from "zod";

import { action, isSuspend, recordId, stableJson, Address } from "@niwa-labs/core";
import type { Action, Caller, OperationId, RecordId } from "@niwa-labs/core";
import { COCKPIT_MODULE, plugin, bindingOf } from "@niwa-labs/plugin";
import { fileURLToPath } from "node:url";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";

import { PendingAsks, outcomeOf, requestOf } from "./access-ask.ts";
import { AskInput, AskOutput, OpenOutput, requestAnswer, requestAsk, requestCancel, requestFind, requestGet, requestList, requestOpen, requestResolve } from "./actions.ts";
import { entityOf, itemOf } from "./entity.ts";
import { holdAnswerCheck, releaseAnswerCheck } from "./question.ts";
import {
  REQUEST_TYPES,
  Deadline,
  RequestAnswered,
  RequestCancelledRecord,
  RequestCreated,
  RequestExpiredRecord,
  RequestId,
  expiryId,
} from "./records.ts";
import { ResolverRegistry } from "./resolver.ts";
import {
  RequestCancelled,
  RequestExpired,
  RequestLedger,
  RequestRefusal,
  checkAnswer,
  decideAnswer,
  decideCancel,
  requestOfCause,
  sameAddress,
} from "./state.ts";

export { ACCESS_ASK } from "./access-ask.ts";
export { question } from "./question.ts";
export type { DeclaredQuestion } from "./question.ts";
export {
  Deadline,
  QuestionName,
  REQUEST_TYPES,
  RequestAnswered,
  RequestCancelledRecord,
  RequestCreated,
  RequestExpiredRecord,
  RequestId,
  expiryId,
} from "./records.ts";
export { ResolverRegistry } from "./resolver.ts";
export type { Resolver, ResolverInfo, ResolverRequest, ResolverResult } from "./resolver.ts";
export { RequestCancelled, RequestExpired, RequestLedger, RequestRefusal, fold } from "./state.ts";
export type { AnswerVerdict, RequestState } from "./state.ts";

/** How long the module waits before it tries again to expire a request it could not. */
const EXPIRY_RETRY_MS = 1000;

/** The longest delay a timer takes: a longer one fires at once. The timer is set again then. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** What the plugin is given. */
export interface RequestsOptions {
  /**
   * The binding says what address a caller speaks as: the same one the other modules that speak by
   * address use. Default: a client speaks as itself, the owner as the owner, nobody else as anybody.
   */
  readonly bind?: CallerBinding;
  /** The resolvers that may answer a request before it reaches its addressee. */
  readonly resolvers?: ResolverRegistry;
  /**
   * How long the owner has to answer the question of an `ask` rule, in milliseconds of the host's
   * clock. A call whose question is not answered in time is denied Ten minutes by default.
   */
  readonly askTimeoutMs?: number;
}

/** How long the owner has to answer a question of a grant when nothing says otherwise. */
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The record a call writes first when it is not inside an invocation, or inside one: the operation
 * and the ordinal of the write (the way the core places a record an action emits). The id of a
 * request is issued from it, so a step made again is the same request.
 */
function createdRecordOf(operation: OperationId): RecordId {
  return recordId(`${operation}/emit/1`);
}

/**
 * The action that asks a question and waits for the answer.
 *
 * The id of the request is issued from the record the ask writes, which follows the operation, so
 * a step made again is the same request. The answer is looked for after the request was written,
 * so one that arrives at once is not missed. A call outside an invocation has nothing to suspend:
 * it returns the request as open.
 *
 * The wait ends with the first of three things: an answer, a cancellation or an expiry. The
 * two latter end the wait with an error the caller catches — `RequestCancelled` or
 * `RequestExpired` — so nobody waits for ever.
 */
export function askWith(bind: CallerBinding, ledger: RequestLedger): Action<z.infer<typeof AskInput>, z.infer<typeof AskOutput>, z.input<typeof AskInput>> {
  return action(requestAsk, {
    // The request is written under the id of the operation, so the question is the same one
    // however many times the call is made: it may be made again, and the wait finds the
    // answer that arrived in the meantime.
    recovery: "repeat",
    effect: "record",
    world: "niwa",
    async run(input, ctx) {
      const id = ledger.ids.issue(createdRecordOf(ctx.operationId));
      // A run asks as itself, whatever the host binds its other callers to: the owner sees who asks.
      // A client is held to its binding; a handler or the host, in-process, may say who asks.
      const from: Address | undefined =
        ctx.caller.kind === "client" && ctx.caller.principal?.kind === "run"
          ? { kind: "client", id: ctx.caller.id }
          : (bind(ctx.caller) ?? (ctx.caller.kind === "client" ? undefined : input.from));
      // While this process waits, the zod schema of the value of a form checks it whole: JSON
      // Schema cannot say a refinement, and an answer that fails one must be refused, not written.
      // Outside an invocation nothing waits, so there is nothing to hold it for.
      const waits = ctx.invocation !== undefined;
      if (waits && input.check !== undefined) holdAnswerCheck(id, input.check);
      let ended;
      try {
        const created = await ctx.emit(RequestCreated, {
          id,
          to: input.to,
          question: input.question,
          input: input.input,
          ...(from === undefined ? {} : { from }),
          ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
        });
        // A call outside an invocation cannot wait: it leaves the request open and says so, and
        // the caller reads the answer later by the id.
        if (!waits) return { id, status: "open" as const };
        ended = await ctx.waitAnyOf(
          [
            { type: RequestAnswered, filter: { id } },
            { type: RequestCancelledRecord, filter: { id } },
            { type: RequestExpiredRecord, filter: { id } },
          ] as const,
          { from: created.seq },
        );
      } catch (error) {
        // A wait that suspends the invocation throws, and the schema stays held for the run that
        // resumes it; any other failure ends the ask, and with it the hold.
        if (!isSuspend(error)) releaseAnswerCheck(id);
        throw error;
      }
      releaseAnswerCheck(id);
      if (ended.type === RequestCancelledRecord.name) throw new RequestCancelled(id);
      if (ended.type === RequestExpiredRecord.name) throw new RequestExpired(id);
      // Only the answer carries an answer: the two ends of a request carry none.
      if (!("answer" in ended.data)) {
        throw new RequestRefusal("bad-answer", `the request "${id}" ended without an answer`);
      }
      return { id, answer: ended.data.answer };
    },
  });
}

/**
 * Who gives the answer of a resolve: the address a client is bound to, which must be the addressee
 * of the request or the owner. The host and the handlers are in-process and answer for nobody.
 */
function answerer(caller: Caller, bind: CallerBinding, to: Address): Address | undefined {
  if (caller.kind !== "client") return undefined;
  const by = bind(caller);
  if (by === undefined) {
    throw new RequestRefusal("unbound", "the caller is not bound to an address, so it cannot answer");
  }
  if (by.kind !== "owner" && !sameAddress(by, to)) {
    throw new RequestRefusal("not-addressee", "only the addressee of the request, or the owner, may answer it");
  }
  return by;
}

/** The actions that read and write the state of requests, from the facts and the binding. */
export function requestActions(ledger: RequestLedger, bind: CallerBinding, resolvers: ResolverRegistry) {
  const answer = action(requestAnswer, {
    // The answer is written under the id of the operation, and the first answer stands:
    // a call that was cut off may be made again, and the same answer stands.
    recovery: "repeat",
    effect: "record",
    world: "niwa",
    async run(input, ctx) {
      const by = bind(ctx.caller);
      const id = ledger.named(input, (request) => by !== undefined && (by.kind === "owner" || sameAddress(by, request.to)));
      const verdict = decideAnswer(id, ledger.requests().get(id), by, input.answer);
      if (verdict.kind === "late") {
        // The request was over before the answer came: nothing is written, and the answerer is
        // told why its answer does not stand instead of being refused.
        return { id, accepted: false, reason: verdict.reason };
      }
      if (verdict.kind === "write") await ctx.emit(RequestAnswered, { id, answer: input.answer, ...(by === undefined ? {} : { by }) });
      return { id, accepted: true };
    },
  });

  const cancel = action(requestCancel, {
    // The cancellation is written under the id of the operation, and the same address
    // cancelling again changes nothing: a call that was cut off may be made again.
    recovery: "repeat",
    effect: "record",
    world: "niwa",
    async run(input, ctx) {
      // A client is held to its binding; a handler or the host, in-process, may say who cancels.
      const by = bind(ctx.caller) ?? (ctx.caller.kind === "client" ? undefined : input.by);
      const id = ledger.named(input, (request) => by !== undefined && (by.kind === "owner" || [request.to, request.from].some((party) => party !== undefined && sameAddress(by, party))));
      const verdict = decideCancel(id, ledger.requests().get(id), by);
      if (verdict === "write") {
        await ctx.emit(RequestCancelledRecord, {
          id,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(by === undefined ? {} : { by }),
        });
      }
      return { id };
    },
  });

  const open = action(requestOpen, {
    // A read of what waits changes nothing: it may be made again.
    recovery: "repeat",
    effect: "read",
    world: "niwa",
    async run(input) {
      const requests: z.infer<typeof OpenOutput>["requests"] = [];
      for (const state of ledger.requests().values()) {
        if (state.status !== "open") continue;
        if (input.to !== undefined && !sameAddress(state.created.to, input.to)) continue;
        requests.push(state.created);
      }
      for (const paused of ledger.paused()) requests.push({ kind: "paused", ...paused, choices: [...paused.choices] });
      return { requests };
    },
  });

  const list = action(requestList, {
    // A read of what exists changes nothing: it may be made again.
    recovery: "repeat",
    effect: "read",
    world: "niwa",
    async run(input) {
      const items = [...ledger.requests().values()]
        .filter(
          (state) =>
            (input.status === undefined || state.status === input.status) &&
            (input.to === undefined || sameAddress(state.created.to, input.to)) &&
            (input.from === undefined || (state.created.from !== undefined && sameAddress(state.created.from, input.from))) &&
            (input.question === undefined || state.created.question === input.question),
        )
        .map(itemOf);
      return { items };
    },
  });

  const get = action(requestGet, {
    recovery: "repeat",
    effect: "read",
    world: "niwa",
    async run(input) {
      return entityOf(ledger.get(input.id));
    },
  });

  const resolve = action(requestResolve, {
    // The resolvers only read and answer, and the answer stands: a resolve that was cut
    // off may be made again.
    recovery: "repeat",
    effect: "record",
    world: "niwa",
    async run(input, ctx) {
      const bound = bind(ctx.caller);
      const id = ledger.named(
        { id: input.id },
        (request) => ctx.caller.kind !== "client" || (bound !== undefined && (bound.kind === "owner" || sameAddress(bound, request.to))),
      );
      const state = ledger.requests().get(id);
      // A client that gives an answer is held to its binding as the one who answers is: the
      // addressee, or the owner. `submit-answer` and answers forwarded by another module reach the request here.
      const by = input.answer === undefined || state === undefined ? undefined : answerer(ctx.caller, bind, state.created.to);
      // The same answer to a request it already answered stands: a call made again says so.
      if (
        input.answer !== undefined &&
        state?.status === "answered" &&
        stableJson(input.answer) === stableJson(state.answer)
      ) {
        return { answered: true };
      }
      if (state?.status !== "open") return { answered: false };
      const { question: name, input: asked, to, from } = state.created;
      // An answer given with the resolve is the answer of the request: it is checked against
      // the schema of the question, as the answer of the addressee is.
      if (input.answer !== undefined) {
        checkAnswer(state.created, input.answer);
        const info = input.info;
        await ctx.emit(RequestAnswered, {
          id,
          answer: input.answer,
          ...(by === undefined ? {} : { by }),
          ...(info?.how === undefined ? {} : { how: info.how }),
          ...(info?.area === undefined ? {} : { area: info.area }),
          ...(info?.source === undefined ? {} : { source: info.source }),
        });
        return { answered: true };
      }
      for (const resolver of resolvers.resolversFor(name)) {
        const result = await resolver({ question: name, input: asked, to, ...(from === undefined ? {} : { from }) });
        if (!result.answered) continue;
        // The answer is the answer of the request: the asker parses it against the schema of
        // its question. How the resolver found it is told apart from it, so that the way it
        // was found does not have to pass the schema of the answer.
        const info = result.info;
        await ctx.emit(RequestAnswered, {
          id,
          answer: result.answer,
          ...(info?.how === undefined ? {} : { how: info.how }),
          ...(info?.area === undefined ? {} : { area: info.area }),
          ...(info?.source === undefined ? {} : { source: info.source }),
        });
        return { answered: true };
      }
      return { answered: false };
    },
  });

  return { answer, cancel, open, list, get, resolve };
}

/** The requests module. */
export function requests(opts: RequestsOptions = {}): Plugin {
  const bind = opts.bind ?? bindingOf();
  const resolvers = opts.resolvers ?? new ResolverRegistry();

  return plugin("requests", (api) => {
    // The page of this plugin in the cockpit: a client module, offered by the path of its source.
    api.offer(COCKPIT_MODULE, { id: "requests", entry: fileURLToPath(new URL("./cockpit/index.tsx", import.meta.url)) });
    api.declare(...REQUEST_TYPES);
    const types = REQUEST_TYPES.map((type) => type.name);
    const ledger = new RequestLedger(types, () => api.journal?.());
    const written = requestActions(ledger, bind, resolvers);
    api.summarize(() => ({ open: [...ledger.requests().values()].filter((state) => state.status === "open").length }));

    api.action(askWith(bind, ledger));
    api.action(written.answer);
    api.action(written.cancel);
    api.action(written.open);
    api.action(written.list);
    api.action(written.get);
    api.action(written.resolve);
    api.action(
      action(requestFind, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        async run(input) {
          const journal = api.journal?.();
          return { id: journal === undefined ? undefined : requestOfCause(journal, recordId(input.cause), input.question) };
        },
      }),
    );

    // A call that meets a rule that asks becomes a request to the owner, and waits here for its end.
    const asks = new PendingAsks();
    api.asker(async (asked, now) => {
      // The record is named here, so the id is issued from it as the id of an ask of a call is.
      const born = recordId(`ask:${crypto.randomUUID()}`);
      const id = ledger.ids.issue(born);
      const ended = asks.expect(id);
      try {
        await api.emit(RequestCreated, requestOf(id, asked, now, opts.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS), { id: born });
      } catch {
        asks.forget(id);
        return "unanswered";
      }
      return ended;
    });

    // The requests whose time ran out end as expired: the one waiting is woken by it.
    //
    // One timer is set for the nearest deadline of the open requests. It is set again when the
    // service starts and whenever a request is created or ends, so nothing polls. The id of the
    // expiry is a function of the request alone, so a host that starts again after the deadline,
    // or a timer that fires for a request that has just ended, writes the same record or none.
    let rearm: (() => void) | undefined;
    api.service((ctx) => {
      let stopped = false;
      let cancel: (() => void) | undefined;

      const arm = (retry: boolean): void => {
        cancel?.();
        cancel = undefined;
        if (stopped) return;
        let nearest: number | undefined;
        for (const state of ledger.requests().values()) {
          const deadline = state.status === "open" ? state.created.deadline : undefined;
          if (deadline !== undefined && (nearest === undefined || deadline < nearest)) nearest = deadline;
        }
        if (nearest === undefined) return;
        const wait = retry ? EXPIRY_RETRY_MS : Math.min(Math.max(nearest - ctx.now(), 0), MAX_TIMER_MS);
        // The clock of the host: a host whose clock is moved by hand expires what is due.
        cancel = ctx.schedule(ctx.now() + wait, () => expire());
      };

      const expire = async (): Promise<void> => {
        cancel = undefined;
        const now = ctx.now();
        let failed = false;
        for (const state of ledger.requests().values()) {
          if (state.status !== "open") continue;
          const { deadline } = state.created;
          if (deadline === undefined || deadline > now) continue;
          if (stopped) return;
          try {
            await ctx.emit(RequestExpiredRecord, { id: state.created.id }, { id: expiryId(state.created.id) });
          } catch (error) {
            // The host is closing, or the write failed: the request stays open and is tried again.
            if (stopped) return;
            failed = true;
            console.error(
              `niwa: the request "${state.created.id}" could not be expired: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        arm(failed);
      };

      rearm = () => arm(false);
      // The requests that were already past their deadline when the host started end now.
      arm(false);
      return () => {
        stopped = true;
        rearm = undefined;
        cancel?.();
        cancel = undefined;
      };
    });

    // A request that is created or ends changes the nearest deadline.
    // The ones that end a question of a rule that asks let its call go on, or deny it.
    api.on(RequestAnswered, (data) => {
      rearm?.();
      asks.end(data.id, outcomeOf(data.answer), data.by);
    });
    api.on(RequestCancelledRecord, (data) => {
      rearm?.();
      asks.end(data.id, "unanswered");
    });
    api.on(RequestExpiredRecord, (data) => {
      rearm?.();
      asks.end(data.id, "unanswered");
    });

    // A request reaches its resolvers as soon as it exists; a resolver that fails leaves it open.
    // A resolver may take its time over one request: the others do not wait for it.
    api.on(RequestCreated, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      rearm?.();
      if (resolvers.resolversFor(data.question).length === 0) return;
      await step(written.resolve, { id: data.id });
    });
  });
}
export {
  AskAnswered,
  AskInput,
  AskOpen,
  AskOutput,
  answeredBy,
  REQUEST_ANSWER,
  REQUEST_ASK,
  REQUEST_CANCEL,
  REQUEST_FIND,
  REQUEST_GET,
  REQUEST_LIST,
  REQUEST_OPEN,
  REQUEST_RESOLVE,
  RequestEntity,
  RequestStatus,
  requestAnswer,
  requestAsk,
  requestCancel,
  requestFind,
  requestGet,
  requestList,
  requestOpen,
  requestResolve,
} from "./actions.ts";
