// Who asks for a task: the address the caller speaks as, never one the input names.
//
// An Assignment goes out from the asker, and whoever reads it takes the asker for the author of the
// words. So a client that is bound to an address asks as that address, and a payload that names
// another is refused; the host and the handlers of plugins, which stand for nobody, may ask in
// another's name.

import { expect, test } from "bun:test";

import type { Address, Caller } from "@niwa-labs/core";
import { MessageSent } from "@niwa-labs/messages/records";
import type { CallerBinding } from "@niwa-labs/plugin";
import { connectAsOwner, createNiwa, messages, tempHome } from "@niwa-labs/testing";

import { taskCreate, tasks } from "../src/index.ts";

/** The client called "asker" speaks as itself; no other client is known to the binding. */
const bind: CallerBinding = (caller: Caller) =>
  caller.kind === "client" && String(caller.id).includes("asker") ? { kind: "client", id: "asker" } : undefined;

const OWNER: Address = { kind: "owner" };

const contract = (askedBy: Address) => ({
  kind: "change",
  description: "Move argument parsing",
  text: "Move argument parsing into its own module.",
  askedBy,
  responsible: { kind: "agent", id: "rin" } as Address,
  reportTo: askedBy,
});

test("a client asks as the address it is bound to, and cannot ask in the name of the owner", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  niwa.use(messages({ bind }));
  niwa.use(tasks({ messages: { bind } }));
  await niwa.serve();

  try {
    const asker = await connectAsOwner(home.path, "asker");
    const nobody = await connectAsOwner(home.path, "nobody");
    try {
      // A payload that names the owner does not make a client the owner.
      await expect(asker.call(taskCreate, contract(OWNER))).rejects.toThrow("not by one the input names");
      // A client the binding does not know does not choose an address at all.
      await expect(nobody.call(taskCreate, contract({ kind: "client", id: "nobody" }))).rejects.toThrow("not bound");
      expect(await niwa.records.read({ types: [MessageSent.name] })).toHaveLength(0);

      // As itself, a client asks, and the Assignment comes from it.
      const own: Address = { kind: "client", id: "asker" };
      const { id } = await asker.call(taskCreate, contract(own));
      await Bun.sleep(200);
      const sent = await niwa.records.read({ types: [MessageSent.name] });
      expect(sent.map((stored) => (stored.data as { from: Address; task: string }).from)).toEqual([own]);
      expect(sent.map((stored) => (stored.data as { task: string }).task)).toEqual([id]);

      // The host stands for nobody: it asks in the name of whom it likes.
      await niwa.call(taskCreate, contract(OWNER));
    } finally {
      await asker.close().catch(() => {});
      await nobody.close().catch(() => {});
    }
  } finally {
    await niwa.close().catch(() => {});
    await home.cleanup();
  }
}, 30_000);
