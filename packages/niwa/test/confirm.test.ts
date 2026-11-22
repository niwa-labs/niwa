// The owner confirms a discovered harness.
//
// The finding runs with a fake PATH: a script named "mcode" that prints a version, and a home
// that is a directory of the test's own. The finding proposes; the proposal is not an instance.
// The confirm plugin asks the owner through the requests module, and the owner's answer decides:
//
//   1. a proposal becomes a request to the owner, with the proposal and the fields to give
//   2. the owner says yes with {id, machine}: the instance is registered
//   3. the owner says no: nothing is registered, and no confirmation is written

import { expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, seq, owner } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import type { StoredRecord } from "@niwa-labs/core";
import { HarnessInstanceRegistry } from "@niwa-labs/harness";
import {
  HARNESS_DISCOVER_ACTION,
  HarnessConfirmed,
  HarnessProposed,
  harnessConfirm,
  harnessDiscovery,
} from "@niwa-labs/sessions";
import type { HarnessDiscoverOutput } from "@niwa-labs/sessions";
import type { CallerBinding } from "@niwa-labs/plugin";
import { REQUEST_ANSWER, RequestCreated, requests } from "@niwa-labs/requests";
import { eventually, tempDir, tempHome, connectAsOwner } from "@niwa-labs/testing";
import { mcodeKind, mcodeSides } from "@niwa-labs/harness-mcode";

/** The version the fake binary says. */
const FAKE_VERSION = "9.9.9-fake";

/** The label the owner's client connects with; the host adds the number of the connection. */
const OWNER_CLIENT = "owner-ui";

/** The owner's client speaks as the owner; every other client speaks as itself. */
const bind: CallerBinding = (caller) => {
  if (caller.kind !== "client") return undefined;
  return caller.id.startsWith(`${OWNER_CLIENT}#`) ? owner : { kind: "client", id: caller.id };
};

/** A directory with a program in it that prints the version it was given. */
async function fakeBinary(dir: string, name: string, version: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), `#!/bin/sh\necho "${version}"\n`);
  await chmod(join(dir, name), 0o755);
}

/**
 * A host with the finding and the confirmation, and a client for the owner.
 *
 * The finding is asked for the kinds of one installation, with a fake PATH of its own.
 */
async function serve(again?: { home: Awaited<ReturnType<typeof tempHome>>; root: string }) {
  const home = again?.home ?? (await tempHome());
  const root = again?.root ?? (await tempDir("confirm"));
  const bin = join(root, "bin");
  await fakeBinary(bin, "mcode", FAKE_VERSION);
  await mkdir(join(root, ".minimax"), { recursive: true });

  const registry = new HarnessInstanceRegistry();
  const host = createNiwa({ home: home.path });
  host.use(requests({ bind }));
  host.use(
    harnessDiscovery({
      kinds: [mcodeKind],
      env: { PATH: bin, HOME: root },
    }),
  );
  host.use(harnessConfirm({ registry, sides: { mcode: mcodeSides } }));
  await host.serve();

  const ownerClient = await connectOwner(home.path);
  return {
    home,
    host,
    registry,
    root,
    ownerClient,
    async close() {
      await ownerClient.close();
      await host.close();
      await home.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The client of the owner, connected to the host. */
async function connectOwner(path: string) {
  const { connect } = await import("@niwa-labs/niwa");
  return connectAsOwner(path, OWNER_CLIENT);
}

/** The records of one type, as the journal holds them. */
async function recordsOf(
  client: Awaited<ReturnType<typeof connectOwner>>,
  type: string,
): Promise<StoredRecord[]> {
  const found: StoredRecord[] = [];
  const stream = client.records.since({ types: [type as never] }) as AsyncGenerator<StoredRecord>;
  for (;;) {
    const next = await Promise.race([stream.next(), Bun.sleep(500).then(() => "timed out" as const)]);
    if (next === "timed out" || next.done === true) break;
    found.push(next.value);
  }
  return found;
}

/** The request the owner is asked, once it is there. */
async function requestOf(world: Awaited<ReturnType<typeof serve>>) {
  await eventually(
    async () => (await recordsOf(world.ownerClient, RequestCreated.name)).length === 1,
    10_000,
    "no request",
  );
  const created = (await recordsOf(world.ownerClient, RequestCreated.name))[0];
  return created?.data as {
    id: string;
    to: { kind: string };
    question: string;
    input: { kind: string; title: string; detail: string; schema: unknown };
  };
}

test("a discovered harness becomes a question for the owner", async () => {
  const world = await serve();
  try {
    await world.host.call(actionName(HARNESS_DISCOVER_ACTION), {});

    const request = await requestOf(world);
    expect(request.to).toEqual(owner);
    expect(request.question).toBe("harness.confirm");
    // The question is a form: the proposal is what was found, and the schema says what the owner must give.
    expect(request.input.kind).toBe("form");
    expect(request.input.title).toBe("add this harness?");
    expect(request.input.detail).toContain("kind: mcode");
    expect(request.input.detail).toContain(`home: ${join(world.root, ".minimax")}`);
    expect(JSON.stringify(request.input.schema)).toContain('"machine"');
  } finally {
    await world.close();
  }
});

test("the owner says yes, and the instance is registered", async () => {
  const world = await serve();
  try {
    await world.host.call(actionName(HARNESS_DISCOVER_ACTION), {});
    const request = await requestOf(world);

    await world.ownerClient.call(REQUEST_ANSWER, {
      id: request.id,
      answer: { form: { answer: "yes", id: "mcode-here", machine: "laptop" } },
    });

    await eventually(() => world.registry.ids().length === 1, 10_000, "the instance was not registered");
    const instance = world.registry.resolve("mcode-here");
    expect(String(instance.id)).toBe("mcode-here");
    expect(String(instance.kind)).toBe("mcode");
    expect(String(instance.machine)).toBe("laptop");
    expect(instance.home).toBe(join(world.root, ".minimax"));
    expect(instance.binary?.version).toBe(FAKE_VERSION);
    expect(instance.sides).toEqual(mcodeSides);

    // The confirmation is a record of its own.
    await eventually(
      async () => (await recordsOf(world.ownerClient, HarnessConfirmed.name)).length === 1,
      10_000,
      "the confirmation was not written",
    );
    const confirmed = (await recordsOf(world.ownerClient, HarnessConfirmed.name))[0];
    expect(confirmed?.data).toMatchObject({
      id: "mcode-here",
      kind: "mcode",
      machine: "laptop",
    });
  } finally {
    await world.close();
  }
});

test("the owner says no, and nothing is registered", async () => {
  const world = await serve();
  try {
    await world.host.call(actionName(HARNESS_DISCOVER_ACTION), {});
    const request = await requestOf(world);

    await world.ownerClient.call(REQUEST_ANSWER, { id: request.id, answer: { form: { answer: "no" } } });

    // The question is answered, and nothing came of it.
    await eventually(
      async () => (await recordsOf(world.ownerClient, "request.answered")).length === 1,
      10_000,
      "the answer was not written",
    );
    await Bun.sleep(300);
    expect(world.registry.ids()).toEqual([]);
    expect(await recordsOf(world.ownerClient, HarnessConfirmed.name)).toHaveLength(0);
  } finally {
    await world.close();
  }
});

test("the proposal is written once, and it is the proposal that is asked about", async () => {
  const world = await serve();
  try {
    await world.host.call(actionName(HARNESS_DISCOVER_ACTION), {});
    const request = await requestOf(world);

    // The proposal the finding wrote is the one the owner is asked about.
    const proposed = (await recordsOf(world.ownerClient, HarnessProposed.name))[0];
    expect(proposed?.data).toMatchObject({ kind: "mcode" });
    const home = (proposed?.data as { home: string } | undefined)?.home ?? "";
    expect(request.input.detail).toContain(`home: ${home}`);
  } finally {
    await world.close();
  }
});

test("a confirmed instance survives a restart, and the same proposal is not asked again", async () => {
  const first = await serve();
  let second: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await first.host.call(actionName(HARNESS_DISCOVER_ACTION), {});
    const request = await requestOf(first);
    await first.ownerClient.call(REQUEST_ANSWER, {
      id: request.id,
      answer: { form: { answer: "yes", id: "mcode-here", machine: "laptop" } },
    });
    await eventually(() => first.registry.ids().length === 1, 10_000, "not registered");
    await eventually(
      async () => (await recordsOf(first.ownerClient, HarnessConfirmed.name)).length === 1,
      10_000,
      "not written",
    );
    await first.ownerClient.close();
    await first.host.close();

    // A new host on the same home, with an empty registry: the journal puts the instance back.
    second = await serve({ home: first.home, root: first.root });
    await eventually(() => second?.registry.ids().length === 1, 10_000, "not restored");
    expect(second.registry.resolve("mcode-here").sides).toEqual(mcodeSides);
    expect(String(second.registry.resolve("mcode-here").machine)).toBe("laptop");

    // The same installation is found again: it is the same proposal, and nobody is asked again.
    await second.host.call(actionName(HARNESS_DISCOVER_ACTION), {});
    await Bun.sleep(500);
    expect(await recordsOf(second.ownerClient, RequestCreated.name)).toHaveLength(1);
    expect(await recordsOf(second.ownerClient, HarnessConfirmed.name)).toHaveLength(1);
    expect(second.registry.ids()).toEqual(["mcode-here"]);
  } finally {
    await (second ?? first).close();
  }
});

test("a no is remembered: the same proposal is not asked again", async () => {
  const world = await serve();
  try {
    await world.host.call(actionName(HARNESS_DISCOVER_ACTION), {});
    const request = await requestOf(world);
    await world.ownerClient.call(REQUEST_ANSWER, { id: request.id, answer: { form: { answer: "no" } } });
    await eventually(
      async () => (await recordsOf(world.ownerClient, "request.answered")).length === 1,
      10_000,
      "not answered",
    );
    await world.host.call(actionName(HARNESS_DISCOVER_ACTION), {});
    await Bun.sleep(500);
    expect(await recordsOf(world.ownerClient, RequestCreated.name)).toHaveLength(1);
    expect(world.registry.ids()).toEqual([]);
  } finally {
    await world.close();
  }
});
