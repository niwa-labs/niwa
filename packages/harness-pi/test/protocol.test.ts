// pi's protocol, typed: a fixture for every variant of every discriminator goes through the parser,
// and what the snapshot does not know becomes a typed unknown and not a crash.

import { expect, test } from "bun:test";

import {
  AssistantMessageEventSchema,
  FileEntrySchema,
  KnownMessageSchema,
  PiCommandSchema,
  PiEventSchema,
  PiUiResponseSchema,
  SuccessResponseSchema,
  UiRequestSchema,
  WIRE_DISCRIMINATORS,
  describeUnknown,
  discriminators,
  parseLine,
} from "../src/protocol/index.ts";
import type { PiIncoming } from "../src/protocol/index.ts";
import {
  ASSISTANT_EVENT_FIXTURES,
  BRANCH_SUMMARY_RETRY,
  COMMAND_FIXTURES,
  ENTRY_FIXTURES,
  EVENT_FIXTURES,
  MESSAGE_FIXTURES,
  REAL_MESSAGE_LINES,
  RESPONSE_FIXTURES,
  UI_FIXTURES,
} from "./wire-fixtures.ts";

const line = (value: object): PiIncoming => parseLine(JSON.stringify(value));

/** Every value of a discriminator has a fixture, and every fixture is a value of it. */
function expectCovered(values: readonly string[], fixtures: Record<string, object>): void {
  expect([...values].sort()).toEqual(Object.keys(fixtures).sort());
}

/* ----------------------------------------------------------- the wire */

test("every event has a fixture, and each is an event of its own type", () => {
  expectCovered(WIRE_DISCRIMINATORS.event, EVENT_FIXTURES);
  for (const [type, fixture] of Object.entries(EVENT_FIXTURES)) {
    const parsed = line(fixture);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") expect<string>(parsed.event.type).toBe(type);
  }
  // The second shape of the one event that has two.
  expect(line(BRANCH_SUMMARY_RETRY).kind).toBe("event");
});

test("every assistantMessageEvent has a fixture, and rides in a message_update", () => {
  expectCovered(WIRE_DISCRIMINATORS.assistantEvent, ASSISTANT_EVENT_FIXTURES);
  for (const [type, fixture] of Object.entries(ASSISTANT_EVENT_FIXTURES)) {
    expect<string>(AssistantMessageEventSchema.parse(fixture).type).toBe(type);
    const usage = (EVENT_FIXTURES.message_update as { usage: object }).usage;
    expect(line({ type: "message_update", usage, assistantMessageEvent: fixture }).kind).toBe("event");
  }
});

test("every request of an extension has a fixture: the four dialogs wait, the five notices do not", () => {
  expectCovered(WIRE_DISCRIMINATORS.uiMethod, UI_FIXTURES);
  const dialogs: string[] = [];
  const notices: string[] = [];
  for (const [method, fixture] of Object.entries(UI_FIXTURES)) {
    expect<string>(UiRequestSchema.parse(fixture).method).toBe(method);
    const parsed = line(fixture);
    if (parsed.kind === "dialog") dialogs.push(method);
    else if (parsed.kind === "notice") notices.push(method);
    else throw new Error(`${method} is neither a dialog nor a notice: ${parsed.kind}`);
  }
  expect(dialogs).toEqual(["select", "confirm", "input", "editor"]);
  expect(notices).toEqual(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
});

test("every command has a success answer that parses, and an error answer any command can have", () => {
  expectCovered(WIRE_DISCRIMINATORS.responseCommand, RESPONSE_FIXTURES);
  for (const [command, fixture] of Object.entries(RESPONSE_FIXTURES)) {
    expect<string>(SuccessResponseSchema.parse(fixture).command).toBe(command);
    const parsed = line(fixture);
    expect(parsed.kind).toBe("response");
    if (parsed.kind === "response") expect(parsed.response?.success).toBe(true);
  }
  for (const command of Object.keys(COMMAND_FIXTURES)) {
    const parsed = line({ id: "1", type: "response", command, success: false, error: "no" });
    expect(parsed).toMatchObject({ kind: "response", response: { success: false, error: "no" } });
  }
  // cycle_model and cycle_thinking_level answer with null when there is nothing to cycle.
  for (const command of ["cycle_model", "cycle_thinking_level"]) {
    const parsed = line({ id: "1", type: "response", command, success: true, data: null });
    expect(parsed).toMatchObject({ kind: "response", response: { success: true } });
  }
});

test("a line pi could not read is answered with an error that has no id", () => {
  const parsed = line({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
  expect(parsed).toMatchObject({ kind: "response", envelope: { command: "parse" }, response: { success: false } });
  if (parsed.kind === "response") expect(parsed.envelope.id).toBeUndefined();
});

test("an extension that failed is told by its own frame", () => {
  const parsed = line({ type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "boom" });
  expect(parsed).toMatchObject({ kind: "extension-error", error: { extensionPath: "/x.ts" } });
});

test("every command niwa could write parses against the commands pi has, and has an answer", () => {
  expectCovered(discriminators(PiCommandSchema, "type"), COMMAND_FIXTURES);
  for (const [type, fixture] of Object.entries(COMMAND_FIXTURES)) {
    expect<string>(PiCommandSchema.parse(fixture).type).toBe(type);
  }
  expect([...discriminators(PiCommandSchema, "type")].sort()).toEqual([...WIRE_DISCRIMINATORS.responseCommand].sort());
});

test("the three answers to a dialog are the three shapes pi reads", () => {
  const answers: object[] = [
    { type: "extension_ui_response", id: "d1", value: "a" },
    { type: "extension_ui_response", id: "d2", confirmed: false },
    { type: "extension_ui_response", id: "d3", cancelled: true },
  ];
  for (const fixture of answers) {
    expect<object>(PiUiResponseSchema.parse(fixture)).toEqual(fixture);
  }
});

/* ------------------------------------------------------- the unknowns */

test("an event this snapshot has not got is a typed unknown carrying the protocol, the type and the raw line", () => {
  const raw = { type: "turn_quantum", flux: 3 };
  const parsed = line(raw);
  expect(parsed).toEqual({
    kind: "unknown",
    variant: { protocol: "pi", level: "frame", discriminator: "turn_quantum", reason: "unrecognized", raw },
  });
  if (parsed.kind === "unknown") {
    expect(describeUnknown(parsed.variant)).toContain('"turn_quantum"');
    expect(describeUnknown(parsed.variant)).toContain('"flux":3');
  }
});

test("a known event whose body is not what the snapshot says is a malformed unknown, not a crash", () => {
  const parsed = line({ type: "queue_update", steering: "not a list", followUp: [] });
  expect(parsed).toMatchObject({ kind: "unknown", variant: { level: "frame", discriminator: "queue_update", reason: "malformed" } });
});

test("an assistantMessageEvent of a type this snapshot has not got is told at its own level", () => {
  const usage = (EVENT_FIXTURES.message_update as { usage: object }).usage;
  const parsed = line({ type: "message_update", usage, assistantMessageEvent: { type: "audio_delta", contentIndex: 0 } });
  expect(parsed).toMatchObject({
    kind: "unknown",
    variant: { level: "assistant-message-event", discriminator: "audio_delta", reason: "unrecognized" },
  });
});

test("a request of an extension with a method this snapshot has not got keeps its id, since pi waits for an answer", () => {
  const parsed = line({ type: "extension_ui_request", id: "x9", method: "pickColor", title: "Color" });
  expect(parsed).toMatchObject({
    kind: "unknown",
    requestId: "x9",
    variant: { level: "ui-request", discriminator: "pickColor", reason: "unrecognized" },
  });
});

test("an answer to a command this snapshot has not got, or with a body it does not know, keeps its envelope", () => {
  const unrecognized = line({ id: "7", type: "response", command: "teleport", success: true, data: {} });
  expect(unrecognized).toMatchObject({
    kind: "response",
    envelope: { id: "7", command: "teleport" },
    response: undefined,
    variant: { level: "response", discriminator: "teleport", reason: "unrecognized" },
  });
  const malformed = line({ id: "8", type: "response", command: "get_state", success: true, data: { sessionId: 5 } });
  expect(malformed).toMatchObject({
    kind: "response",
    envelope: { id: "8" },
    response: undefined,
    variant: { discriminator: "get_state", reason: "malformed" },
  });
});

test("an answer with an id and little else is still an answer: it settles its request and has no body", () => {
  const parsed = line({ type: "response", id: "5", data: {} });
  expect(parsed).toMatchObject({ kind: "response", envelope: { id: "5" }, response: undefined, variant: { level: "response" } });
});

test("the stream of a pi that predates the projection (no usage, no tool id) and an agent_end without willRetry still parse", () => {
  expect(line({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } }).kind).toBe("event");
  expect(line({ type: "agent_end", messages: [] }).kind).toBe("event");
});

test("a line that is not an object with a type is unreadable, never a throw", () => {
  for (const text of ["not json", "[1,2]", "3", '{"no":"type"}', '{"type":4}']) {
    expect(parseLine(text).kind).toBe("unreadable");
  }
});

/* ------------------------------------------------------ session files */

test("every entry of a session file has a fixture, and each parses as its own type", () => {
  expectCovered(discriminators(FileEntrySchema, "type"), ENTRY_FIXTURES);
  for (const [type, fixture] of Object.entries(ENTRY_FIXTURES)) {
    expect<string>(FileEntrySchema.parse(fixture).type).toBe(type);
  }
});

test("every role of a message has a fixture, and each parses as its own role", () => {
  expectCovered(discriminators(KnownMessageSchema, "role"), MESSAGE_FIXTURES);
  for (const [role, fixture] of Object.entries(MESSAGE_FIXTURES)) {
    expect<string>(KnownMessageSchema.parse(fixture).role).toBe(role);
  }
});

test("lines that pi really wrote parse, with every block it put in them", () => {
  for (const [what, text] of Object.entries(REAL_MESSAGE_LINES)) {
    const parsed = FileEntrySchema.safeParse(JSON.parse(text));
    expect(parsed.success, what).toBe(true);
  }
  const reasoning = FileEntrySchema.parse(JSON.parse(REAL_MESSAGE_LINES.assistantThinkingText!));
  if (reasoning.type !== "message" || reasoning.message.role !== "assistant" || typeof reasoning.message.content === "string") {
    throw new Error("not an assistant message");
  }
  expect(reasoning.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
});

test("a block this snapshot cannot place is carried whole and does not make its message unknown", () => {
  const block = { type: "audio", data: "AAA" };
  const entry = FileEntrySchema.parse({
    ...ENTRY_FIXTURES.message,
    message: { ...MESSAGE_FIXTURES.assistant, content: [{ type: "text", text: "kept" }, block] },
  });
  if (entry.type !== "message" || entry.message.role !== "assistant" || typeof entry.message.content === "string") {
    throw new Error("not an assistant message");
  }
  expect(entry.message.content).toEqual([{ type: "text", text: "kept" }, { type: "unrecognized", raw: block }]);
});

test("the discriminators of a nested union are all found", () => {
  expect(WIRE_DISCRIMINATORS.event).toContain("summarization_retry_attempt_start");
  expect<number>(PiEventSchema.options.length).toBe(Object.keys(EVENT_FIXTURES).length);
});
