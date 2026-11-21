// Access asks are owner-only requests. The owner answers them through request.answer.

import { afterEach, expect, test } from "bun:test";

import { z } from "zod";

import { action, actionName, grant, principalOf } from "@niwa-labs/core";
import type { RuleSpec, Token } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { REQUEST_ANSWER, REQUEST_GET, REQUEST_OPEN, REQUEST_RESOLVE, requestOpen } from "@niwa-labs/requests/records";
import {
  connect,
  connectAsOwner,
  createNiwa,
  eventually,
  HostError,
  pick,
  requests,
  tempHome,
  token,
} from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";

import { SUBMIT_ANSWER_ACTION, submitAnswerAction } from "../src/index.ts";

const ran: string[] = [];

const probe = plugin("self-answer-probe", (api) => {
  api.action(
    action("probe.run", {
      description: "Records the call.",
      input: z.object({ n: z.string() }),
      output: z.object({ ran: z.string() }),
      recovery: "repeat",
      effect: "write",
      run: async (input) => {
        ran.push(input.n);
        return { ran: input.n };
      },
    }),
  );
  api.action(submitAnswerAction(() => api.journal?.()));
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  ran.length = 0;
});

/** A host with the default binding, one session that asks under a rule, and the owner. */
async function served(rules: RuleSpec[]) {
  const home = await tempHome();
  cleanups.push(() => home.cleanup());
  const host: Host = createNiwa({ home: home.path });
  cleanups.push(() => host.close());
  host.use(probe, requests());
  await host.serve();
  const secret: Token = host.issueToken(principalOf("session", "s1"), { grant: grant(rules) });
  const owner = await connectAsOwner(home.path);
  cleanups.push(() => owner.close());
  const session = await connect({ home: home.path, id: "s1", token: secret });
  cleanups.push(() => session.close());
  const watcher = await connect({ home: home.path, id: "s1-second", token: secret });
  cleanups.push(() => watcher.close());

  const open = async () => requestOpen.output.parse(await owner.call(REQUEST_OPEN, {})).requests;
  const waitForAsk = async (otherId?: string) => {
    const next = async () => (await open()).find((entry) => "id" in entry && entry.id !== otherId);
    await eventually(async () => (await next()) !== undefined);
    const asked = await next();
    if (asked === undefined || !("id" in asked)) throw new Error("the access request is no longer open");
    return asked;
  };
  const run = (n: string) => {
    const pending = session.call(actionName("probe.run"), { n });
    // A failed assertion can close the client before this call is awaited.
    void pending.catch(() => {});
    return pending;
  };
  return { host, home: home.path, owner, watcher, open, waitForAsk, run };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HostError);
  return (error as HostError).message;
}

const ASKING: RuleSpec[] = [
  { do: "probe.run", ask: true },
  SUBMIT_ANSWER_ACTION,
  "request.resolve",
  "request.answer",
];

test("a session cannot answer the access ask about its own call, by submit-answer, resolve or answer", async () => {
  const s = await served(ASKING);
  const pending = s.run("mine");
  const asked = await s.waitForAsk();
  const { id } = asked;
  expect(id).toMatch(/^req-[0-9a-f]{6,8}$/);
  expect(asked).toMatchObject({
    answerPolicy: "owner-only",
    to: { kind: "owner" },
    question: "access.ask",
    input: { kind: "permission", subject: { who: "session:s1", action: "probe.run", input: { n: "mine" } } },
  });

  const answer = pick("once");
  expect(await s.watcher.call(actionName(SUBMIT_ANSWER_ACTION), { question: id, value: "once" })).toEqual({ accepted: false });
  expect(await s.watcher.call(REQUEST_RESOLVE, { id, answer })).toEqual({ answered: false });
  expect(await refusal(s.watcher.call(REQUEST_ANSWER, { id, answer }))).toContain("Only the owner");

  expect(ran).toEqual([]);
  expect(await s.open()).toEqual([asked]);

  expect(await s.owner.call(REQUEST_ANSWER, { id, answer })).toEqual({ id, accepted: true });
  expect(await pending).toEqual({ ran: "mine" });
  expect(await s.owner.call(REQUEST_GET, { id })).toMatchObject({ id, status: "answered", by: { kind: "owner" }, answer });
  expect(await s.open()).toEqual([]);
  expect(ran).toEqual(["mine"]);
});

test("the owner can allow only the call named by the request answer", async () => {
  const s = await served(ASKING);
  const first = s.run("first");
  const asked = await s.waitForAsk();
  const second = s.run("second");
  const { id } = await s.waitForAsk(asked.id);

  const answer = pick("once");
  expect(await s.owner.call(REQUEST_RESOLVE, { id, answer })).toEqual({ answered: false });
  expect(await s.owner.call(REQUEST_GET, { id })).toMatchObject({ status: "open" });
  expect(ran).toEqual([]);

  expect(await s.owner.call(REQUEST_ANSWER, { id, answer })).toEqual({ id, accepted: true });
  expect(await second).toEqual({ ran: "second" });
  expect(await s.open()).toEqual([asked]);
  expect(ran).toEqual(["second"]);

  expect(await s.owner.call(REQUEST_ANSWER, { id: asked.id, answer })).toEqual({ id: asked.id, accepted: true });
  expect(await first).toEqual({ ran: "first" });
  expect(await s.open()).toEqual([]);
  expect(ran).toEqual(["second", "first"]);
});

test("the host cannot decide an access ask and the owner's refusal ends the call", async () => {
  const s = await served(ASKING);
  const pending = s.run("refused");
  const asked = await s.waitForAsk();
  const { id } = asked;
  expect(await s.host.call(REQUEST_RESOLVE, { id, answer: pick("once") })).toEqual({ answered: false });
  await expect(s.host.call(REQUEST_ANSWER, { id, answer: pick("once") })).rejects.toThrow("Only the owner");
  expect(await s.open()).toEqual([asked]);
  expect(ran).toEqual([]);

  const answer = pick("no");
  expect(await s.owner.call(REQUEST_ANSWER, { id, answer })).toEqual({ id, accepted: true });
  expect(await refusal(pending)).toContain("refused by the owner");
  expect(await s.owner.call(REQUEST_GET, { id })).toMatchObject({ id, status: "answered", by: { kind: "owner" }, answer });
  expect(await s.open()).toEqual([]);
  expect(ran).toEqual([]);
});

test("a connection with no token stands on the default profile, and the owner's token is the owner", async () => {
  const s = await served(ASKING);
  const plain = await connect({ home: s.home, id: "owner:web" });
  const unknown = await connect({ home: s.home, token: token("zzzz") });
  cleanups.push(async () => {
    await plain.close();
    await unknown.close();
  });
  for (const client of [plain, unknown]) {
    expect(await refusal(client.call(actionName("probe.run"), { n: "x" }))).toContain("not in the grant");
    expect(await refusal(client.call(REQUEST_OPEN, {}))).toContain("not in the grant");
    expect(await refusal(client.call(actionName("access.switch"), { all: "off" }))).toContain("not in the grant");
    expect(await refusal(client.call(actionName("access.mine"), {}))).toContain("not in the grant");
  }
  expect(ran).toEqual([]);

  // The owner, with the owner's token, is not limited: the same calls go through.
  expect(await s.owner.call(actionName("probe.run"), { n: "owner" })).toEqual({ ran: "owner" });
  expect(await s.open()).toEqual([]);
});

test("the default profile is what a connection with no token may do, and the owner may change it", async () => {
  const s = await served([]);
  const plain = await connect({ home: s.home, id: "plain" });
  cleanups.push(() => plain.close());
  await s.owner.call(actionName("access.profile.set"), { name: "default", rules: ["probe.run"] });
  expect(await plain.call(actionName("probe.run"), { n: "allowed-now" })).toEqual({ ran: "allowed-now" });
  expect(await refusal(plain.call(REQUEST_OPEN, {}))).toContain("not in the grant");
});
