// The host program for the live test of a session that asks the owner.
//
// It serves the sessions module with one installation: the "mcode-test" harness, whose control
// side drives a real MiniMax Code session. The installation answers natively by default, but
// here it is told it cannot: the question niwa asks of a session is then a request, and the
// answer comes back through "submit-answer".
//
// The plugin "ownerask" does two things, in one invocation:
//
//   1. it asks the owner a question: the request is addressed to the owner, and the owner
//      answers it through "request.answer";
//   2. it asks the session the niwa way, with a schema: the question is a request too, the
//      session answers it through "submit-answer", and the value it answers with is checked
//      against the schema.
//
// The home directory comes from argv[2]. The host only starts when the file is run directly.

import { homedir } from "node:os";
import { join } from "node:path";

import { action, actionName, record, owner } from "@niwa-labs/core";
import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import type { ActionName } from "@niwa-labs/core";
import { harnessId, machineId } from "@niwa-labs/harness";
import type { Harness, SessionControl } from "@niwa-labs/harness";
import { messages } from "@niwa-labs/messages";
import { question, requests } from "@niwa-labs/requests";
import { sessions } from "@niwa-labs/sessions";
import { z } from "zod";

import { mcode, mcodeSides } from "@niwa-labs/harness-mcode";
import type { McodeSessionControl } from "@niwa-labs/harness-mcode";

/** The id of the installation the sessions live on. */
const HARNESS = harnessId("mcode-test");

/** The model the sessions run on. */
const MODEL = "minimax/MiniMax-M3.1-Flash";

/** Where the installation keeps its sessions. */
const INSTALLATION_HOME = join(homedir(), ".minimax");

/** The kind of the installation: the mcode kind, bound to this home. */
const kind = mcode({ harness: HARNESS, home: INSTALLATION_HOME, control: { mode: "full", model: MODEL } });

/**
 * The installation the sessions module serves.
 *
 * The installation is told it cannot answer by itself: the ask goes the niwa way, so the
 * question becomes a request that waits for the answer.
 */
const instance: Harness = {
  id: HARNESS,
  kind: kind.kind,
  machine: machineId("machine-1"),
  home: INSTALLATION_HOME,
  sides: {
    ...mcodeSides,
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

const control = kind.control;
if (control === undefined) {
  throw new Error("the mcode kind has no control side");
}
if (!stoppable<McodeSessionControl>(control)) {
  throw new Error("the control side of the mcode kind cannot stop what it started");
}

/** The question the owner is asked: a free text. */
const Choice = question("ownerask.choice", { kind: "text", title: "What is the answer?" });

/** The record that starts the scenario: its handler asks the owner and the session. */
const Asked = record("ownerask.asked", z.object({ what: z.string() }));

/** The record that says what the scenario came back with. */
const Answered = record(
  "ownerask.answered",
  z.object({
    ownerAnswer: z.unknown().optional(),
    sessionAnswer: z.unknown().optional(),
    error: z.string().optional(),
  }),
);

/** The action the test calls to start the scenario. */
const ASK: ActionName = actionName("ownerask.ask");

/** The action that reports the outcome. */
const REPORT: ActionName = actionName("ownerask.report");

/** The schema the answer of the session must pass. */
const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

/**
 * The plugin of the scenario.
 *
 * The asks happen inside an invocation, so the waits for the answers can last as long as they
 * must: a call outside an invocation cannot wait.
 */
function asker(): ReturnType<typeof plugin> {
  return plugin("ownerask-asker", (api) => {
    api.declare(Asked, Answered);

    api.action(
      action(ASK, {
        description: "Starts the scenario: the owner is asked, and the session is asked the niwa way.",
        input: z.object({ what: z.string() }),
        output: z.object({ started: z.boolean() }),
        recovery: "repeat",
        effect: "write",
        async run(input, ctx) {
          await ctx.emit(Asked, { what: input.what });
          return { started: true };
        },
      }),
    );

    api.action(
      action(REPORT, {
        description: "Says what the scenario came back with.",
        input: z.object({
          ownerAnswer: z.unknown().optional(),
          sessionAnswer: z.unknown().optional(),
          error: z.string().optional(),
        }),
        output: z.object({ reported: z.boolean() }),
        recovery: "repeat",
        effect: "write",
        async run(input, ctx) {
          await ctx.emit(Answered, input);
          return { reported: true };
        },
      }),
    );

    api.on(Asked, { concurrency: Number.POSITIVE_INFINITY }, async (data, step) => {
      let outcome: { ownerAnswer?: unknown; sessionAnswer?: unknown; error?: string };
      try {
        // 1. The owner is asked: the request is addressed to the owner, and only the owner may
        //    answer it.
        const ownerAnswer = await step<
          { to: typeof owner; question: unknown; input: unknown },
          unknown
        >(
          "request.ask" as never,
          { to: owner, ...Choice, input: { ...Choice.input, detail: data.what } } as never,
          { key: "ask-owner" },
        );

        // 2. The session is asked the niwa way, with a schema. The session is given niwa's own
        //    MCP server, so it can call "submit-answer".
        const started = await step<
          { harness: string; prompt: string; visible: { actions: string[]; disabledTools: string[] } },
          { session: string }
        >(
          "session.start" as never,
          {
            harness: HARNESS,
            prompt: "You answer questions for a caller. You answer with the niwa tool submit-answer.",
            visible: { actions: ["submit-answer"], disabledTools: [] },
          } as never,
          { key: "start-session" },
        );
        const answer = await step<
          { session: string; prompt: string; schema: object },
          { value: unknown }
        >(
          "session.ask" as never,
          {
            session: started.session,
            prompt: `Answer with the word ${String((ownerAnswer as { text?: string } | undefined)?.text ?? "ok")}.`,
            schema: ANSWER_SCHEMA,
          } as never,
          { key: "ask-session" },
        );

        outcome = { ownerAnswer, sessionAnswer: answer.value };
      } catch (error) {
        // A step that failed pauses the invocation and one that waits suspends it: both are
        // the invocation's own, so they go on up. Only a refusal is an outcome.
        if (error instanceof Error && (error.name === "PauseSignal" || error.name === "SuspendSignal")) throw error;
        outcome = {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      }
      await step(REPORT, outcome, { key: "report" });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun ask-owner-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(messages());
  const made = sessions({
    harnesses: [{ instance, reading: kind.reading, control }],
    // A session that may see niwa actions is given niwa's own server, with this home.
    niwaMcp: {
      command: "bun",
      args: [join(import.meta.dir, "../../bin/niwa.ts"), "--home", home, "mcp"],
    },
  });
  // A session's own client speaks as its session, so it answers the question addressed to it.
  niwa.use(requests({ bind: made.bind() }));
  niwa.use(asker());
  niwa.use(made);
  await niwa.serve();

  // The agents this host started are stopped with the host: no child outlives it.
  process.on("SIGTERM", () => {
    void (async () => {
      // Each part is stopped even when the one before it failed, and the process always exits.
      await control.dispose().catch(() => undefined);
      await niwa.close().catch(() => undefined);
      process.exit(0);
    })();
  });
}
