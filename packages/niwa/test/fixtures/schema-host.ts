// The host program for the live test of an answer by schema.
//
// It serves the sessions module with two installations: the "codex-test" harness, whose control
// side answers a question by itself (structured output), and the "mcode-test" harness, whose
// control side is asked the question the niwa way: the question is a request, it waits for an
// answer, and the answer comes back through "submit-answer".
//
// The mcode installation is given niwa's own MCP server, so the session sees the actions it was
// given and can call "submit-answer" through it.
//
// The plugin "schema" declares the record "schema.asked" and asks the session it names: the ask runs
// inside the handler, so it runs inside an invocation and the wait for the answer can last as
// long as it must.
//
// The home directory comes from argv[2]. The host only starts when the file is run directly.

import { homedir } from "node:os";
import { join } from "node:path";

import { action, actionName, record } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { ActionName } from "@niwa-labs/core";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl } from "@niwa-labs/harness";
import { requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { z } from "zod";

import { codex, codexSides } from "@niwa-labs/harness-codex";
import type { CodexSessionControl } from "@niwa-labs/harness-codex";
import { mcode, mcodeSides } from "@niwa-labs/harness-mcode";
import type { McodeSessionControl } from "@niwa-labs/harness-mcode";

/** The id of the installation that answers natively. */
const CODEX_HARNESS = harnessId("codex-test");

/** The id of the installation that is asked the niwa way. */
const MCODE_HARNESS = harnessId("mcode-test");

/** The model the codex sessions run on. */
const CODEX_MODEL = "gpt-6-luna";

/** The model the MiniMax Code sessions run on. */
const MCODE_MODEL = "minimax/MiniMax-M3.1-Flash";

/** Where the codex installation keeps its sessions. */
const CODEX_HOME = join(homedir(), ".codex");

/** Where the MiniMax Code installation keeps its sessions. */
const MCODE_HOME = join(homedir(), ".minimax");

/** The kind of the codex installation. */
const codexKind = codex({ id: CODEX_HARNESS, home: CODEX_HOME, model: CODEX_MODEL, control: { mode: "full" } });

/** The installation that answers natively. */
const codexInstance: Harness = {
  id: CODEX_HARNESS,
  kind: codexKind.instance.kind,
  machine: machineId("machine-1"),
  home: CODEX_HOME,
  sides: codexSides,
};

/** The kind of the MiniMax Code installation. */
const mcodeKind = mcode({ id: MCODE_HARNESS, home: MCODE_HOME, model: MCODE_MODEL, control: { mode: "full" } });

/** The installation that is asked the niwa way. */
const mcodeInstance: Harness = {
  id: MCODE_HARNESS,
  kind: mcodeKind.instance.kind,
  machine: machineId("machine-1"),
  home: MCODE_HOME,
  sides: {
    ...mcodeSides,
    // The installation is told it cannot answer by itself: the ask goes the niwa way, and the
    // question becomes a request that waits for the answer.
    control: {
      start: true,
      resume: true,
      send: true,
      interrupt: true,
      ask: true,
      structuredOutput: false, launch: { model: false, effort: [], modes: [] },
    },
  },
};

/** Does this control side stop what it started? */
function stoppable<T extends SessionControl & { dispose(): Promise<void> }>(
  control: SessionControl,
): control is T {
  return "dispose" in control;
}

/** The record that says what an ask came back with. */
const Answered = record(
  "schema.answered",
  z.object({ session: z.string(), value: z.unknown().optional(), error: z.string().optional() }),
);

/** The action the ask is made through. */
const SESSION_ASK: ActionName = actionName("session.ask");

/** The action that starts an ask, so that the test can call it through the public API. */
const ASK: ActionName = actionName("schema.ask");

/** The schema the answer must pass: one integer. */
const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
};

/**
 * A schema no answer can satisfy: the number must be at least ten and at most five.
 *
 * The prompt asks for a number, so the model tries to give one, and the schema refuses every
 * number there is. A `const` would not do: a harness that decodes under the schema can produce
 * the one value the schema allows, and that value is an answer.
 */
const IMPOSSIBLE_SCHEMA = {
  type: "object",
  properties: { answer: { type: "integer", minimum: 10, maximum: 5 } },
  required: ["answer"],
};

/** The record that asks: a handler of it makes the ask inside an invocation. */
const Asked = record("schema.asked", z.object({ session: z.string(), schema: z.enum(["valid", "impossible"]) }));

/** The action that writes down what an ask came back with. */
const REPORT: ActionName = actionName("schema.report");

/**
 * The plugin that asks.
 *
 * The ask happens inside an invocation, so the wait for the answer can last as long as it must
 * and survives a restart: the test calls "schema.ask", which writes the record "schema.asked", and the
 * handler of that record makes the ask as a step. A call made outside an invocation cannot
 * wait, so the ask is never made that way.
 */
function asker(): ReturnType<typeof plugin> {
  return plugin("schema-asker", (api) => {
    api.declare(Answered);
    api.declare(Asked);
    api.action(
      action(ASK, {
        description: "Starts an ask of a session for a value that passed a schema.",
        input: z.object({ session: z.string(), schema: z.enum(["valid", "impossible"]) }),
        output: z.object({ started: z.boolean() }),
        recovery: "repeat",
        effect: "write",
        async run(input, ctx) {
          await ctx.emit(Asked, input);
          return { started: true };
        },
      }),
    );
    const report = action(REPORT, {
      description: "Says what an ask came back with.",
      input: z.object({ session: z.string(), value: z.unknown().optional(), error: z.string().optional() }),
      output: z.object({ reported: z.boolean() }),
      recovery: "repeat",
      effect: "write",
      async run(input, ctx) {
        await ctx.emit(Answered, input);
        return { reported: true };
      },
    });
    api.action(report);
    api.on(Asked, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      const schema = data.schema === "impossible" ? IMPOSSIBLE_SCHEMA : ANSWER_SCHEMA;
      let outcome: { session: string; value?: unknown; error?: string };
      try {
        const answer = await step<{ session: string; prompt: string; schema: object }, { value: unknown }>(
          SESSION_ASK,
          {
            session: data.session,
            prompt: "What is 21 + 21? Answer with the number only.",
            schema,
          },
          { key: "ask" },
        );
        outcome = { session: data.session, value: answer.value };
      } catch (error) {
        // A step that failed pauses the invocation and one that waits suspends it: both are
        // the invocation's own, so they go on up. Only a refusal is an outcome.
        if (error instanceof Error && (error.name === "PauseSignal" || error.name === "SuspendSignal")) throw error;
        outcome = {
          session: data.session,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      }
      await step(report, outcome, { key: "report" });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun schema-host.ts <home>");
    process.exit(2);
  }

  const codexControl = codexKind.control;
  if (codexControl === undefined) throw new Error("the codex kind has no control side");
  if (!stoppable<CodexSessionControl>(codexControl)) {
    throw new Error("the control side of the codex kind cannot stop what it started");
  }
  const mcodeControl = mcodeKind.control;
  if (mcodeControl === undefined) throw new Error("the mcode kind has no control side");
  if (!stoppable<McodeSessionControl>(mcodeControl)) {
    throw new Error("the control side of the mcode kind cannot stop what it started");
  }

  const niwa = createNiwa({ home });
  niwa.use(asker());
  const made = sessions({
    harnesses: [
      { instance: codexInstance, reading: codexKind.reading, control: codexControl },
      { instance: mcodeInstance, reading: mcodeKind.reading, control: mcodeControl },
    ],
    // A session that may see niwa actions is given niwa's own server, with this home.
    niwaMcp: {
      command: "bun",
      args: [join(import.meta.dir, "../../bin/niwa.ts"), "--home", home, "mcp"],
    },
  });
  niwa.use(made);
  // The requests module serves "request.ask": the question a session cannot answer by itself. A session's
  // own client speaks as its session, so it answers the question addressed to it.
  niwa.use(requests({ bind: made.bind() }));
  await niwa.serve();

  // The agents this host started are stopped with the host: no child outlives it.
  process.on("SIGTERM", () => {
    void (async () => {
      await codexControl.dispose();
      await mcodeControl.dispose();
      await niwa.close();
      process.exit(0);
    })();
  });
}
