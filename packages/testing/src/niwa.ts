// What the tests that compose a whole niwa need: the base stack of plugins over a fake harness.

export { FAKE_HARNESS, FakeControl, fakeHarness } from "./fake-harness.ts";
export type { FakeHarness, FakeHarnessOptions } from "./fake-harness.ts";
export { baseStack } from "./stack.ts";
export type { BaseStack, BaseStackOptions } from "./stack.ts";
