// A read of a script under a rule that asks is denied, not put to the owner: only a call of an
// action asks. A wait, a read of a plugin's state and a read of records are reads.

import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { actionName, grant, principalOf } from "@niwa-labs/core";
import { connect } from "@niwa-labs/client";
import type { NiwaApi } from "@niwa-labs/client";
import { createNiwa } from "@niwa-labs/host";
import type { Host } from "@niwa-labs/host";
import { requests } from "@niwa-labs/requests";
import { tempHome } from "@niwa-labs/testing";
import { workflow } from "@niwa-labs/workflow";

const homes: Array<{ cleanup(): Promise<void> }> = [];
const hosts: Host[] = [];
const clients: NiwaApi[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const home of homes.splice(0)) await home.cleanup();
});

const attempt = (body: string): string => `(async () => { try { await ${body}; return "read"; } catch (error) { return error.message; } })()`;

test("a wait, a state read and a records read under a rule that asks are denied without a question", async () => {
  const home = await tempHome();
  homes.push(home);
  const host = createNiwa({ home: home.path });
  host.use(requests(), workflow());
  await host.serve();
  hosts.push(host);
  const token = host.issueToken(principalOf("session", "s"), {
    grant: grant(["workflow.start", { do: "niwa.records.read", ask: true }]),
  });
  const starter = await connect({ home: home.path, id: "session:s", token });
  clients.push(starter);
  const file = join(home.path, "reads.js");
  await writeFile(file, [
    'export default workflow({ uses: ["niwa.records.read"], output: z.json() }, async () => ({',
    `  state: await ${attempt('read.state("workflow")')},`,
    `  records: await ${attempt("read.records({ types: [\"workflow.run.requested\"] })")},`,
    `  wait: await ${attempt('wait("workflow.run.finished", { timeout: "1s" })')},`,
    "}));",
  ].join("\n"));
  const done = (await starter.call(actionName("workflow.start"), { file, wait: true, timeoutMs: 20_000 })) as {
    state: string;
    outcome?: { result?: Record<string, string> };
  };
  expect(done.state).toBe("finished");
  for (const why of Object.values(done.outcome?.result ?? {})) expect(why).toContain("asks");
  expect((await host.records.read()).filter((row) => row.type === "request.created")).toEqual([]);
}, 60_000);
