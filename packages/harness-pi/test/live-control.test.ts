// The pi control side, live.
//
// A real pi is started in its RPC mode, given one turn, and the signs of life are watched: the
// turn started and the turn ended. The session pi names is the one niwa holds, and the file pi
// names is the one a later start opens again.
//
// The test is skipped unless NIWA_LIVE=1 and PI_BIN points at a pi that runs. The binary is
// named by the environment, because the `pi` on the PATH is not always the one that works: the
// shim of a package manager may point at a version that is not installed.
//
// The model is named too, as PI_MODEL, in pi's own words (`<provider>/<model>`). It is given to
// pi when it starts, so the test does not depend on the model the installation remembers.

import { expect, test } from "bun:test";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { harnessId, promptFromText } from "@niwa-labs/harness";
import type { LifeEvent } from "@niwa-labs/harness";

import { PiControl } from "../src/control.ts";

import { tempDir, live } from "@niwa-labs/testing";

/** The pi that is run. It is named by the environment, so the test runs the one that works. */
const PI_BIN = process.env.PI_BIN ?? "";

/** The model the turn is given, in pi's own words. */
const PI_MODEL = process.env.PI_MODEL ?? "";

/** The installation the session belongs to. */
const HARNESS = harnessId("pi-live");

/** How long one turn may take before the test gives up on it. */
const TURN_DEADLINE_MS = 180_000;

/**
 * A home of pi's own for the test.
 *
 * pi reads its settings, its extensions and its sessions from its home, and the home of the
 * person running the test may hold a package that does not load with this version of pi. So the
 * home of the test is a copy of the settings and the extensions of the real one, without the
 * packages: the packages are what break.
 */
async function piHome(): Promise<string> {
  const home = await tempDir("live-pi-home");
  const real = join(homedir(), ".pi", "agent");
  const settings = await readFile(join(real, "settings.json"), "utf8").catch(() => "{}");
  const parsed = JSON.parse(settings) as Record<string, unknown>;
  delete parsed.packages;
  await Bun.write(join(home, "settings.json"), JSON.stringify(parsed, null, 2));
  await mkdir(join(home, "extensions"), { recursive: true });
  await cp(join(real, "extensions"), join(home, "extensions"), { recursive: true }).catch(
    () => undefined,
  );
  return home;
}

/** The control side of the test, with the pi and the model the environment names. */
async function controlSide(): Promise<PiControl> {
  const home = await piHome();
  const control = new PiControl({
    mode: "full",
    harness: HARNESS,
    binary: PI_BIN,
    home,
    ...(PI_MODEL === "" ? {} : { model: PI_MODEL }),
  });
  return control;
}

test(
  "the pi control side runs a real turn, and the signs of life come",
  async () => {
    if (!live || PI_BIN === "") return;
    const control = await controlSide();
    try {
      // The session is started without a turn: the signs of life are forward-only, so a watcher
      // that arrives after the turn ended sees nothing of it. The session has no id until the
      // start has named it, so the turn is the one that is sent afterwards.
      const { session: id } = await control.start({ prompt: promptFromText("") });
      // pi names its own session.
      expect(id.native.length).toBeGreaterThan(0);
      expect(id.harness).toBe(HARNESS);
      expect(await control.state(id)).toBe("idle");

      // The signs of life are watched before the turn begins.
      const seen: LifeEvent[] = [];
      const watcher = (async () => {
        for await (const event of control.life(id)) {
          seen.push(event);
          if (event.kind === "turn-ended") break;
        }
      })().catch(() => {});

      const receipt = await control.send(id, "say hello in three words");
      expect(receipt.status).toBe("started");

      const deadline = Date.now() + TURN_DEADLINE_MS;
      while (!seen.some((event) => event.kind === "turn-ended") && Date.now() < deadline) {
        await Bun.sleep(50);
      }

      await watcher;

      // The turn started and the turn ended are both reported.
      expect(seen.some((event) => event.kind === "turn-started")).toBe(true);
      expect(seen.some((event) => event.kind === "turn-ended")).toBe(true);

      // The session is idle again: the run it began has ended.
      expect(await control.state(id)).toBe("idle");
    } finally {
      await control.dispose();
    }
  },
  TURN_DEADLINE_MS,
);

test(
  "the pi control side resumes a real session by its own file",
  async () => {
    if (!live || PI_BIN === "") return;
    const control = await controlSide();
    try {
      const { session: id } = await control.start({ prompt: promptFromText("") });
      expect(id.native.length).toBeGreaterThan(0);

      // pi writes the file of a session when the session has something to write, so the turn is
      // run first: a session that never ran has no file to be opened again by.
      const seen: LifeEvent[] = [];
      const watcher = (async () => {
        for await (const event of control.life(id)) {
          seen.push(event);
          if (event.kind === "turn-ended") break;
        }
      })().catch(() => {});
      await control.send(id, "say hello in three words");
      const deadline = Date.now() + TURN_DEADLINE_MS;
      while (!seen.some((event) => event.kind === "turn-ended") && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      await watcher;
      expect(seen.some((event) => event.kind === "turn-ended")).toBe(true);

      // The session is opened again by the file pi itself named: the process is ended, and a new
      // one is started on that file.
      await control.stop(id);
      expect(await control.state(id)).toBe("unknown");

      await control.resume(id);
      expect(await control.state(id)).toBe("idle");
    } finally {
      await control.dispose();
    }
  },
  TURN_DEADLINE_MS,
);
