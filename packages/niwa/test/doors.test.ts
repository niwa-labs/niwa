// Doors: who a connection is comes from its token, not from the
// label it gives itself; a closed record type is written only by the plugin that declares it.

import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { z } from "zod";

import {
  CORE_TYPES,
  OptionIdSchema,
  action,
  actionName,
  grant,
  record,
  principalOf,
  seq,
} from "@niwa-labs/core";
import { connect, readOwnerToken, token, tokenOf } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { Host } from "@niwa-labs/host";
import type { NiwaApi } from "@niwa-labs/client";
import type { Token } from "@niwa-labs/core";
import { REQUEST_ANSWER, REQUEST_OPEN, RequestAnswered, requests } from "@niwa-labs/requests";
import { eventually, tempHome, connectAsOwner, requestIdOf } from "@niwa-labs/testing";

import { Start, executor } from "./fixtures/requests-host.ts";

const Closed = record("doors.closed", z.object({ n: z.number() }));
const Opened = record("doors.opened", z.object({ n: z.number() }), { open: true });

/** The plugin that owns the two types, and two actions to tell what a session sees. */
const doors = plugin("doors-check", (api) => {
  api.declare(Closed, Opened);
  api.action(
    action("doors.ping", {
      description: "Answers.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      recovery: "repeat",
      effect: "write",
      run: async () => ({ ok: true }),
    }),
  );
  api.action(
    action("doors.pong", {
      description: "Answers too.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      recovery: "repeat",
      effect: "write",
      run: async () => ({ ok: true }),
    }),
  );
});

async function served(): Promise<{ host: Host; home: { path: string; cleanup(): Promise<void> } }> {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(doors, requests(), executor());
  await host.serve();
  return { host, home };
}

const Listed = z.object({ requests: z.array(z.object({ id: z.string() })) });

test("a client that says owner in its label, without the owner's token, is not the owner", async () => {
  const { host, home } = await served();
  const clients: NiwaApi[] = [];
  try {
    const asker = await connectAsOwner(home.path);
    clients.push(asker);
    await asker.emit(Start, { release: "1.0" });

    // A client the host made a token for, with no grant, calls itself `owner:web`.
    const forged = await connect({ home: home.path, id: "owner:web", token: host.issueToken(principalOf("client", "owner:web")) });
    const wrong = await connect({ home: home.path, id: "owner:web", token: token("zzzz") });
    const bare = await connect({ home: home.path, id: "owner:web" });
    clients.push(forged, wrong, bare);
    let id = "";
    await eventually(async () => {
      const listed = Listed.parse(await forged.call(REQUEST_OPEN, {}));
      id = listed.requests[0]?.id ?? "";
      return id !== "";
    });

    // The label means nothing. A token the host did not make, and no token, stand on the default
    // profile, which does not answer a request.
    await expect(forged.call(REQUEST_ANSWER, { id, answer: { ids: [OptionIdSchema.parse("main")] } })).rejects.toThrow("only the addressee");
    await expect(wrong.call(REQUEST_ANSWER, { id, answer: { ids: [OptionIdSchema.parse("main")] } })).rejects.toThrow("not in the grant");
    await expect(bare.call(REQUEST_ANSWER, { id, answer: { ids: [OptionIdSchema.parse("main")] } })).rejects.toThrow("not in the grant");

    // The owner's token is the owner, whatever the client calls itself.
    const owner = await connectAsOwner(home.path, "mallory");
    clients.push(owner);
    const answered = await owner.call(REQUEST_ANSWER, { id, answer: { ids: [OptionIdSchema.parse("main")] } });
    expect(answered).toMatchObject({ accepted: true });
  } finally {
    for (const client of clients) await client.close();
    await host.close();
    await home.cleanup();
  }
});

test("the owner's token is made at the first start, kept for the owner only, and survives a restart", async () => {
  const home = await tempHome();
  try {
    const first = createNiwa({ home: home.path });
    first.use(doors);
    await first.serve();
    const made = readOwnerToken(home.path);
    expect(made).toBeDefined();
    expect(made?.length).toBeLessThanOrEqual(4);
    expect(statSync(`${home.path}/owner.token`).mode & 0o777).toBe(0o600);
    expect(statSync(`${home.path}/host.key`).mode & 0o777).toBe(0o600);
    const issued = await first.records.read({ types: [CORE_TYPES.accessIssued] });
    expect(issued).toHaveLength(1);
    // The journal keeps the HMAC of the token, never the token.
    const data = issued[0]?.data as { mac: string; principal: unknown };
    expect(data.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(data.mac).not.toBe(made);
    expect(Object.values(data)).not.toContain(made);
    await first.close();

    const second = createNiwa({ home: home.path });
    second.use(doors, requests(), executor());
    await second.serve();
    // The same token is still the owner's: no second one was made.
    expect(readOwnerToken(home.path)).toBe(made as Token);
    expect(await second.records.read({ types: [CORE_TYPES.accessIssued] })).toHaveLength(1);
    await second.close();
  } finally {
    await home.cleanup();
  }
});

test("a token is only what the host made: a session's token names a session and nothing more", async () => {
  const { host, home } = await served();
  try {
    const secret = host.issueToken(principalOf("session", "mark-1"), { grant: grant(["doors.ping"]) });
    const session = await connect({ home: home.path, id: "owner:web", token: secret });
    try {
      expect(await session.call(actionName("doors.ping"), {})).toEqual({ ok: true });
      // What the session does not see, it does not call, whatever its own server shows.
      await expect(session.call(actionName("doors.pong"), {})).rejects.toThrow("is not in the grant");
    } finally {
      await session.close();
    }

    // The token outlives a restart of the host: the table folds from the journal.
    await host.close();
    const again = createNiwa({ home: home.path });
    again.use(doors);
    await again.serve();
    const back = await connect({ home: home.path, token: secret });
    try {
      expect(await back.call(actionName("doors.ping"), {})).toEqual({ ok: true });
      await expect(back.call(actionName("doors.pong"), {})).rejects.toThrow("is not in the grant");
    } finally {
      await back.close();
      await again.close();
    }
  } finally {
    await home.cleanup();
  }
});

test("a closed record type is also written by a subject whose grant has an emit rule for it, and the write names the grant", async () => {
  const { host, home } = await served();
  const clients: NiwaApi[] = [];
  try {
    const allowed = await connect({
      home: home.path,
      token: host.issueToken(principalOf("session", "mark-emit"), { grant: grant(["emit:doors.closed"]) }),
    });
    const narrow = await connect({
      home: home.path,
      token: host.issueToken(principalOf("session", "mark-narrow"), { grant: grant(["emit:doors.*"]) }),
    });
    const asking = await connect({
      home: home.path,
      token: host.issueToken(principalOf("session", "mark-ask"), { grant: grant([{ do: "emit:doors.closed", ask: true }]) }),
    });
    clients.push(allowed, narrow, asking);

    const written = await allowed.emit(Closed, { n: 5 });
    expect(written.actor).toMatchObject({ kind: "client", principal: { kind: "session", id: "mark-emit" }, grant: expect.any(String) });
    await narrow.emit(Closed, { n: 6 });
    // A rule that asks is, for now, a refusal with the reason "ask"; and the refusal is a decision record.
    await expect(asking.emit(Closed, { n: 7 })).rejects.toThrow("ask");
    const decided = await host.records.read({ types: [CORE_TYPES.accessDecided] });
    const verdicts = decided.map((row) => row.data as { verb: string; name: string; outcome: string });
    expect(verdicts.filter((row) => row.verb === "emit" && row.name === "doors.closed").map((row) => row.outcome)).toEqual([
      "allowed",
      "allowed",
      "denied",
    ]);
  } finally {
    for (const client of clients) await client.close();
    await host.close();
    await home.cleanup();
  }
});

test("a closed record type is written only by the plugin that owns it; an open one by anyone", async () => {
  const { host, home } = await served();
  const clients: NiwaApi[] = [];
  try {
    const plain = await connectAsOwner(home.path);
    const session = await connect({
      home: home.path,
      token: host.issueToken(principalOf("session", "mark-2"), { grant: grant([]) }),
    });
    const stranger = await connect({
      home: home.path,
      token: host.issueToken(principalOf("plugin", "someone-else")),
    });
    const owning = await connect({ home: home.path, token: host.issueToken(principalOf("plugin", "doors-check")) });
    const owner = await connectAsOwner(home.path);
    clients.push(plain, session, stranger, owning, owner);

    for (const client of [plain, session, stranger, owner]) {
      await expect(client.emit(Closed, { n: 1 })).rejects.toThrow('"doors.closed" is closed');
    }
    // The type that makes an owner's answer is closed too: a session cannot forge it.
    await expect(
      session.emit(RequestAnswered, { id: requestIdOf("forged"), answer: { ids: [OptionIdSchema.parse("main")] }, by: { kind: "owner" } }),
    ).rejects.toThrow('"request.answered" is closed');

    const written = await owning.emit(Closed, { n: 2 });
    expect(String(written.type)).toBe("doors.closed");
    expect(written.actor).toMatchObject({ kind: "client", principal: { kind: "plugin", id: "doors-check" } });

    // An open type is anyone's to write.
    for (const client of [plain, session, stranger]) await client.emit(Opened, { n: 3 });
  } finally {
    for (const client of clients) await client.close();
    await host.close();
    await home.cleanup();
  }
});

test("a surface takes the token of its environment before the owner's own", async () => {
  const home = await tempHome();
  try {
    const host = createNiwa({ home: home.path });
    host.use(doors);
    await host.serve();
    const owners = readOwnerToken(home.path);
    expect(tokenOf(home.path, {})).toBe(owners as Token);
    expect(tokenOf(home.path, { NIWA_ID: "ab12" })).toBe(token("ab12"));
    // An empty variable is no variable.
    expect(tokenOf(home.path, { NIWA_ID: " " })).toBe(owners as Token);
    expect(() => tokenOf(home.path, { NIWA_ID: "toolong" })).toThrow("1 to 4 letters or digits");
    await host.close();
  } finally {
    await home.cleanup();
  }
});

test("a token is not more than 4 characters and nothing but letters and digits", () => {
  expect(() => token("")).toThrow();
  expect(() => token("abcde")).toThrow();
  expect(() => token("a b")).toThrow();
  expect(token("aZ09")).toBe("aZ09" as Token);
});
