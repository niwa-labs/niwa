// What a client reads over the wire, `records.read`, `records.since`, `trace` and `causes`, is held
// to its grant as the same actions are when they are called: the owner reads everything, a subject
// reads when its grant lets it call the action, and a subject whose grant does not is refused.

import { afterEach, expect, test } from "bun:test";

import { grant, principalOf, seq } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { record } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { connectAsOwner, tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Fact = record("wire-read.fact", z.object({ n: z.number() }), { open: true });

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

async function served() {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(plugin("wire-read", (api) => api.declare(Fact)));
  await host.serve();
  hosts.push(host);
  const owner = await connectAsOwner(home.path);
  clients.push(owner);
  const fact = await host.emit(Fact, { n: 1 });
  const as = async (name: string, rules: string[]): Promise<NiwaApi> => {
    const token = host.issueToken(principalOf("session", name), { grant: grant(rules) });
    const client = await connect({ home: home.path, id: `session:${name}`, token });
    clients.push(client);
    return client;
  };
  return { owner, fact, as };
}

test("the owner reads over the wire", async () => {
  const { owner, fact } = await served();
  expect((await owner.records.read(seq(0), { type: Fact })).map((one) => one.id)).toEqual([fact.id]);
  expect((await owner.trace(fact.id)).map((one) => one.id)).toContain(fact.id);
  expect(await owner.causes(fact.id)).toBeDefined();
  const seen = [];
  for await (const one of owner.records.since(seq(0), { type: Fact })) {
    seen.push(one.id);
    break;
  }
  expect(seen).toEqual([fact.id]);
});

test("a subject whose grant does not let it call the reads is refused them over the wire", async () => {
  const { fact, as } = await served();
  const none = await as("none", ["task.*"]);
  await expect(none.records.read(seq(0), { type: Fact })).rejects.toThrow("is not in the grant");
  await expect(none.trace(fact.id)).rejects.toThrow("is not in the grant");
  await expect(none.causes(fact.id)).rejects.toThrow("is not in the grant");

  const subscriber = await as("subscriber", ["task.*"]);
  const stream = subscriber.records.since(seq(0), { type: Fact })[Symbol.asyncIterator]();
  await expect(stream.next()).rejects.toThrow("is not in the grant");
});

test("a subject whose grant lets it call the reads gets them over the wire", async () => {
  const { fact, as } = await served();
  const reader = await as("reader", ["niwa.records.read", "niwa.trace", "niwa.causes"]);
  expect((await reader.records.read(seq(0), { type: Fact })).map((one) => one.id)).toEqual([fact.id]);
  expect((await reader.trace(fact.id)).map((one) => one.id)).toContain(fact.id);
  expect(await reader.causes(fact.id)).toBeDefined();
  const seen = [];
  for await (const one of reader.records.since(seq(0), { type: Fact })) {
    seen.push(one.id);
    break;
  }
  expect(seen).toEqual([fact.id]);
});
