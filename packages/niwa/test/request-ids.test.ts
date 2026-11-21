// The ids of requests: niwa issues `req-<hex>` from the
// record the ask writes, so a call that is made again is the same request; `request.ask` returns the id with
// the answer; `request.list` and `request.get` find a request again by id, or by a unique start or end of it.

import { afterEach, expect, test } from "bun:test";

import { actionName, issueId, record, seq, owner } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Host } from "@niwa-labs/host";
import type { NiwaApi } from "@niwa-labs/client";
import type { StoredRecord } from "@niwa-labs/core";
import {
  REQUEST_ANSWER,
  REQUEST_ASK,
  REQUEST_CANCEL,
  RequestCreated,
  answeredBy,
  requestAsk,
  requests,
} from "@niwa-labs/requests";
import { eventually, tempHome, connectAsOwner, pick } from "@niwa-labs/testing";
import { z } from "zod";

import { Answered, OWNER_CLIENT, ReleaseBranch, Start, bind, executor } from "./fixtures/requests-host.ts";

const ID = /^req-[0-9a-f]{6,8}$/;

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

/** A host with the requests module and the executor, on a home of its own or the one given. */
async function serve(path?: string): Promise<{ host: Host; owner: NiwaApi; home: string }> {
  const home = path === undefined ? await tempHome() : undefined;
  if (home !== undefined) homes.push(home);
  const dir = path ?? home?.path ?? "";
  const host = createNiwa({ home: dir });
  host.use(requests({ bind }), executor());
  await host.serve();
  hosts.push(host);
  const client = await connectAsOwner(dir, OWNER_CLIENT);
  clients.push(client);
  return { host, owner: client, home: dir };
}

interface Listed {
  readonly items: ReadonlyArray<{ id: string; description: string; status: string; question: string; from?: { kind: string; id?: string } }>;
}

const listOf = async (client: NiwaApi, filter: Record<string, unknown> = {}): Promise<Listed> => (await client.call(actionName("request.list"), filter)) as Listed;

const createdOf = async (host: Host): Promise<StoredRecord[]> => (await host.records.read()).filter((one) => one.type === RequestCreated.name);

const dataId = (one: StoredRecord): string => (one.data as { id: string }).id;

test("a step that asks gets an id issued from the record the ask wrote, and the id is the one the list shows", async () => {
  const { host, owner: client } = await serve();
  await client.emit(Start, { release: "1.0" });
  await client.emit(Start, { release: "1.0" });
  await eventually(async () => (await createdOf(host)).length === 2, 10_000, "two requests");
  const created = await createdOf(host);

  for (const one of created) {
    expect(dataId(one)).toMatch(ID);
    // The id is a function of the record the ask wrote: the ledger can find the ask again from it.
    expect(dataId(one)).toBe(issueId("request", one.id, []));
    expect(String(one.id)).toMatch(/\/emit\/1$/);
  }
  // Two identical asks are two requests.
  expect(new Set(created.map(dataId)).size).toBe(2);
  expect((await listOf(client)).items.map((item) => item.id).sort()).toEqual(created.map(dataId).sort());
});

/** What an asker was told of its ask: the id of the request, and the answer. */
const Told = record("ids.told", z.object({ id: z.string(), answer: z.unknown() }), { open: true });
const Ask = record("ids.ask", z.object({ n: z.number() }), { open: true });

test("a step that asks is told the id of its request together with the answer", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests({ bind }));
  host.use(
    plugin("ids-asker", (api) => {
      api.declare(Ask, Told);
      api.on(Ask, { concurrency: Number.POSITIVE_INFINITY }, async (_data, step) => {
        const { id, answer } = answeredBy(await step(requestAsk, { to: owner, ...ReleaseBranch }));
        await step.emit(Told, { id, answer });
      });
    }),
  );
  await host.serve();
  hosts.push(host);
  const client = await connectAsOwner(home.path, OWNER_CLIENT);
  clients.push(client);

  await client.emit(Ask, { n: 1 });
  await eventually(async () => (await createdOf(host)).length === 1, 10_000, "the request");
  const [created] = await createdOf(host);
  const id = dataId(created as StoredRecord);
  await client.call(REQUEST_ANSWER, { id, answer: pick("next") });
  await eventually(async () => (await host.records.read()).some((one) => one.type === Told.name), 10_000, "told");
  const told = (await host.records.read()).find((one) => one.type === Told.name);
  expect(told?.data).toEqual({ id, answer: pick("next") });
});

test("a call that is not in a step writes its request under the same scheme: the id is issued from the record it wrote", async () => {
  const { host, owner: client } = await serve();
  // Nothing can suspend a direct call, so its wait ends at once; the request it wrote stays.
  await client.call(REQUEST_ASK, { to: owner, ...ReleaseBranch }).catch(() => undefined);
  const [created] = await createdOf(host);
  if (created === undefined) throw new Error("no request was created");
  expect(dataId(created)).toBe(issueId("request", created.id, []));
  expect(String(created.id)).toMatch(/\/emit\/1$/);
});

test("a host that serves again finds the request it asked: the same id, and no second request", async () => {
  const first = await serve();
  await first.owner.emit(Start, { release: "2.0" });
  await eventually(async () => (await createdOf(first.host)).length === 1, 10_000, "the request");
  const [created] = await createdOf(first.host);
  const id = dataId(created as StoredRecord);
  await first.owner.close();
  await first.host.close();

  const second = await serve(first.home);
  expect((await listOf(second.owner)).items.map((item) => item.id)).toEqual([id]);
  await second.owner.call(REQUEST_ANSWER, { id, answer: pick("main") });
  await eventually(async () => (await second.host.records.read()).some((one) => one.type === Answered.name), 10_000, "the work goes on");
  // The replayed ask found its request again: nothing was written twice.
  expect(await createdOf(second.host)).toHaveLength(1);
});

test("request.list filters by how a request stands, who may answer it and the question; each item has an id and a description", async () => {
  const { host, owner: client } = await serve();
  await client.emit(Start, { release: "3.0" });
  await client.emit(Start, { release: "3.1" });
  await eventually(async () => (await createdOf(host)).length === 2, 10_000, "two requests");
  const [one, two] = (await createdOf(host)).map(dataId);
  if (one === undefined || two === undefined) throw new Error("no requests");

  const all = await listOf(client);
  expect(all.items).toHaveLength(2);
  for (const item of all.items) {
    expect(item.id).toMatch(ID);
    expect(item.description).toBe("Which branch?");
    expect(item).toMatchObject({ status: "open", question: "release.branch" });
  }

  await client.call(REQUEST_ANSWER, { id: one, answer: pick("main") });
  await eventually(async () => (await listOf(client, { status: "answered" })).items.length === 1, 10_000, "answered");
  expect((await listOf(client, { status: "answered" })).items.map((item) => item.id)).toEqual([one]);
  expect((await listOf(client, { status: "open" })).items.map((item) => item.id)).toEqual([two]);
  expect((await listOf(client, { status: "cancelled" })).items).toEqual([]);
  expect((await listOf(client, { to: owner })).items).toHaveLength(2);
  expect((await listOf(client, { to: { kind: "client", id: "nobody" } })).items).toEqual([]);
  expect((await listOf(client, { question: "release.branch" })).items).toHaveLength(2);
  expect((await listOf(client, { question: "release.other" })).items).toEqual([]);
  expect((await listOf(client, { from: { kind: "client", id: "nobody" } })).items).toEqual([]);

  await client.call(REQUEST_CANCEL, { id: two });
  await eventually(async () => (await listOf(client, { status: "cancelled" })).items.length === 1, 10_000, "cancelled");
});

test("request.get takes the id or a unique end of it, refuses several with the candidates, and says what is unknown", async () => {
  const { host, owner: client } = await serve();
  await client.emit(Start, { release: "4.0" });
  await client.emit(Start, { release: "4.1" });
  await eventually(async () => (await createdOf(host)).length === 2, 10_000, "two requests");
  const [one, two] = (await createdOf(host)).map(dataId);
  if (one === undefined || two === undefined) throw new Error("no requests");
  const get = async (id: string): Promise<{ id: string; status: string; input: { title: string }; answer?: unknown }> =>
    (await client.call(actionName("request.get"), { id })) as { id: string; status: string; input: { title: string }; answer?: unknown };

  expect(await get(one)).toMatchObject({ id: one, status: "open", input: { title: "Which branch?" } });
  expect((await get(two.slice(-6))).id).toBe(two);

  await expect(get("req-")).rejects.toThrow(/names 2 requests/);
  await expect(get("req-ffffff")).rejects.toThrow(/req-ffffff/);

  await client.call(REQUEST_ANSWER, { id: one.slice(-6), answer: pick("next") });
  expect(await get(one)).toMatchObject({ status: "answered", answer: pick("next") });
});
