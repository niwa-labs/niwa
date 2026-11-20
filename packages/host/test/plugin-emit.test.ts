// A plugin's own `emit` writes only the types that plugin declared.

import { expect, test } from "bun:test";

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record, seq } from "@niwa-labs/core";
import type { PluginApi } from "@niwa-labs/plugin";
import type { StoredRecord } from "@niwa-labs/core";
import { tempHome } from "@niwa-labs/testing";
import { z } from "zod";

const Mine = record("emit-test.mine", z.object({ n: z.number() }));
const Theirs = record("emit-test.theirs", z.object({ n: z.number() }));

test("a plugin emits its own type as the host, and is refused another plugin's type", async () => {
  const home = await tempHome();
  const niwa = createNiwa({ home: home.path });
  let api: PluginApi | undefined;
  niwa.use(
    plugin("emit-mine", (a) => {
      a.declare(Mine);
      api = a;
    }),
  );
  niwa.use(plugin("emit-theirs", (a) => a.declare(Theirs)));
  try {
    await niwa.serve();
    const written = await api?.emit(Mine, { n: 1 });
    expect(written?.actor).toEqual({ kind: "host" });
    expect(written?.cause).toBeNull();
    await expect(api?.emit(Theirs, { n: 1 })).rejects.toThrow("emit-test.theirs");
    const seen: StoredRecord[] = [];
    for await (const found of niwa.records.since(seq(0))) {
      seen.push(found);
      if (found.type === Mine.name) break;
    }
    expect(seen.map((r) => r.type)).toContain(Mine.name);
  } finally {
    await niwa.close();
    await home.cleanup();
  }
});
