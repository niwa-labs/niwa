// The script of a day's work.
//
// Five tiny studies go out in parallel to agents in two harnesses. One of them is given
// a wrong instruction on purpose: the check of the results finds the answer that holds no
// three lines, and that study is sent again with the right instruction, under a key of its
// own. Then a merge agent gets the five results and returns one list.
//
// The script holds nothing: every call is a step of the run, and a call that finished is
// answered from the journal when the run is made again.

import { claudePrompt } from "./claude.ts";

/** The topics of the day's studies. */
const TOPICS = ["tides", "sourdough", "rainbows", "toucans", "volcanoes"];

/** The harness of each study: two harnesses share the day. */
const HARNESSES = ["mcode-test", "claude-test", "mcode-test", "claude-test", "mcode-test"];

/** The topic whose study is given the wrong instruction. */
const WRONG = 2;

/**
 * How a study is asked for: three facts, one per line.
 *
 * The question carries a schema, so the answer is a JSON object with one field. The wording says
 * where the facts go: a question that says "answer with the three lines" fights the shape the
 * question asks for, and the answer comes back as text that no schema holds.
 */
const instruction = (topic) =>
  `List 3 facts about ${topic}. Answer with exactly three lines, one fact per line. ` +
  `Put the three lines in the answer field of the JSON object, one line per line, and put ` +
  `nothing else in the object.`;

/**
 * The wrong instruction: one word, so the answer holds no three lines.
 *
 * It asks for the same shape, so the study comes back with an answer — an answer of one line,
 * which is what the check of the results is looking for.
 */
const wrongInstruction = () =>
  "Reply with the single word ok. Put that word in the answer field of the JSON object and put " +
  "nothing else in the object.";

/** A prompt for the harness: Claude Code is told not to call its advisor, the other is not. */
const forHarness = (harness, text) => (harness.startsWith("claude") ? claudePrompt(text) : text);

/** The lines of an answer that hold something. */
const linesOf = (answer) =>
  answer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The text an agent call answered with. */
const textOf = (answer) => {
  if (answer === null || typeof answer !== "object") return "";
  const text = answer.answer;
  return typeof text === "string" ? text : "";
};

export default workflow({ phases: [{ title: "Study" }, { title: "Merge" }], uses: ["session.start.mcode-test", "session.start.claude-test"], output: z.json() }, async () => {
  phase("Study");
  const answers = await parallel(
    TOPICS.map((topic, index) => () =>
      agent(forHarness(HARNESSES[index], index === WRONG ? wrongInstruction() : instruction(topic)), {
        harness: HARNESSES[index],
        label: `study:${topic}`,
      }),
    ),
  );

  // The check of the results: an answer without three lines is not the study that was asked
  // for, so that study is asked for again, under a key of its own.
  const studies = [];
  for (const [index, topic] of TOPICS.entries()) {
    const text = textOf(answers[index]);
    if (linesOf(text).length >= 3) {
      studies.push(text);
      continue;
    }
    log(`the study of ${topic} answered without three lines: it is sent again`);
    const again = await agent(forHarness(HARNESSES[index], instruction(topic)), {
      harness: HARNESSES[index],
      label: `study:${topic}:fixed`,
    });
    studies.push(textOf(again));
  }

  phase("Merge");
  const merged = await agent(
    claudePrompt([
      "Five studies of a day are given. Return one list: one line for each topic below, and",
      "each line starts with the name of its topic. Put the list in the answer field of the JSON",
      "object, one topic per line, and put nothing else in the object.",
      `Topics: ${TOPICS.join(", ")}.`,
      "Studies:",
      ...TOPICS.map((topic, index) => `${topic}: ${studies[index]}`),
    ].join("\n")),
    { harness: "claude-test", label: "merge:day" },
  );

  return { topics: TOPICS, merged: textOf(merged) };
});
