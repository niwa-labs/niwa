// A live subscription says when the host is listening for it: a frame sent right after that is received.

import { afterEach, expect, test } from "bun:test";

import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { connectAsOwner, tempHome } from "@niwa-labs/testing";

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
  await host.serve();
  hosts.push(host);
  const client = await connectAsOwner(home.path);
  clients.push(client);
  return { home: home.path, client };
}

test("a frame sent right after ready is received, with no pause between", async () => {
  const { client } = await served();
  for (let round = 0; round < 20; round += 1) {
    const channel = `chat-${round}`;
    const frames = client.live.subscribe(channel);
    await frames.ready;
    await client.live.send(channel, { channel, data: round });
    const first = await Promise.race([frames.next(), Bun.sleep(2_000).then(() => "lost" as const)]);
    expect(first).toEqual({ done: false, value: { channel, data: round } });
    await frames.return();
  }
});

test("ready is refused when the subscription ends before the host answered", async () => {
  const { client } = await served();
  const frames = client.live.subscribe("chat");
  await frames.return();
  await expect(frames.ready).rejects.toThrow();
});

test("a plain client's subscription is ready and hears a frame another client sent", async () => {
  const { home, client } = await served();
  const other = await connect({ home });
  clients.push(other);
  const frames = other.live.subscribe("quiet");
  await frames.ready;
  await client.live.send("quiet", { channel: "quiet", data: 1 });
  expect((await frames.next()).value).toEqual({ channel: "quiet", data: 1 });
  await frames.return();
});
