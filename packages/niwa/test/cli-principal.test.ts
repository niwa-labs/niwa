// Who the command line speaks as: the owner when no `NIWA_ID` is set, and the session that `NIWA_ID`
// carries when it is. The owner's token is in the home and the process can read it, but a token
// given in the environment wins.

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";

import { action, grant, principalOf } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { requests } from "@niwa-labs/requests";
import { tempHome } from "@niwa-labs/testing";

const probe = plugin("cli-principal-probe", (api) => {
  api.action(
    action("probe.run", {
      description: "Answers with its input.",
      input: z.object({ n: z.string() }),
      output: z.object({ ran: z.string() }),
      recovery: "repeat",
      effect: "write",
      run: async (input) => ({ ran: input.n }),
    }),
  );
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The CLI of a home, started as a program with this environment. */
async function cli(home: string, args: string[], env: Record<string, string>): Promise<{ out: string; err: string; code: number }> {
  const child = Bun.spawn([process.execPath, new URL("../bin/niwa.ts", import.meta.url).pathname, "--home", home, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NIWA_ID: "", ...env },
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { out, err, code: await child.exited };
}

test("the CLI is the owner with no NIWA_ID, and the session of NIWA_ID when it is set", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(probe, requests());
  await host.serve();
  cleanups.push(async () => {
    await host.close();
    await home.cleanup();
  });
  const secret = host.issueToken(principalOf("session", "s2"), { grant: grant(["access.mine", "request.open"]) });

  const owner = await cli(home.path, ["--json", "access.mine"], {});
  expect(owner.code).toBe(0);
  expect(JSON.parse(owner.out)).toMatchObject({ principal: { kind: "owner" } });

  // The owner's token is in the home and the process can read it: NIWA_ID still wins.
  const session = await cli(home.path, ["--json", "access.mine"], { NIWA_ID: secret });
  expect(session.code).toBe(0);
  expect(JSON.parse(session.out)).toMatchObject({ principal: { kind: "session", id: "s2" }, unlimited: false });
  const refused = await cli(home.path, ["access.switch", "--all", "off"], { NIWA_ID: secret });
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("not in the grant");
});
