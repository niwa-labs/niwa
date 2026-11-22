import { expect, mock, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { actionName } from "@niwa-labs/core";
import { opencode } from "@niwa-labs/harness-opencode";
import { nono, sandbox, srt } from "@niwa-labs/sandbox";
import { sessions } from "@niwa-labs/sessions";
import { createNiwa, tempHome } from "@niwa-labs/testing";

test.each([nono(), srt()])("the host refuses a boxed OpenCode launch through $name before probing", async (adapter) => {
  const home = await tempHome();
  const root = await realpath(home.path);
  const data = join(root, "opencode");
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  const binding = opencode({ home: data, control: { binary: "/missing-opencode", env } });
  const available = mock(async () => false);
  const boxes = sandbox({ adapter: { ...adapter, available } });
  const host = createNiwa({ home: home.path });

  try {
    host.use(sessions({ harnesses: [binding], sandbox: boxes }));
    await host.serve();
    const reason = expect.stringContaining(`${adapter.name} cannot restrict a TCP loopback listener`);
    await expect(host.call(actionName("session.start"), { harness: binding.instance.id, prompt: "" })).rejects.toMatchObject({
      code: "box-refused", message: reason,
    });
    await expect(host.call(actionName("session.resume"), { session: { harness: binding.instance.id, native: "ses_existing" } })).rejects.toMatchObject({
      code: "box-refused", message: reason,
    });
    expect(available).not.toHaveBeenCalled();

    const plan = boxes.plan({ cwd: process.cwd(), owner: "another-harness", defaults: { allow: [] }, network: false });
    const closed = plan.closed.filter(({ from }) => from === `harness:${binding.instance.id}`).map(({ path }) => path);
    expect(closed.sort()).toEqual([data, ...Object.values(env).map((base) => join(base, "opencode"))].sort());
  } finally {
    await host.close();
    await home.cleanup();
  }
});
