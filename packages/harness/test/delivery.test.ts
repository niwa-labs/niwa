import { expect, test } from "bun:test";

import { NotSent } from "@niwa-labs/core";
import { InputNotSent, InputPossiblySent, Unavailable, Unsupported, harnessId, inputFailure, outcomeOf } from "@niwa-labs/harness";

const H = harnessId("probe");

test("a send that gave a receipt was accepted", async () => {
  expect(await outcomeOf(Promise.resolve({ status: "started", turn: 1 }))).toEqual({ status: "accepted", receipt: { status: "started", turn: 1 } });
});

test("only a failure that says the input never went is unsent; any other may have gone", async () => {
  expect((await outcomeOf(Promise.reject(new InputNotSent(H, "send", "not running")))).status).toBe("unsent");
  expect((await outcomeOf(Promise.reject(new Unsupported(H, "control", "send")))).status).toBe("unsent");
  expect((await outcomeOf(Promise.reject(new InputPossiblySent(H, "send", "closed")))).status).toBe("possibly-sent");
  expect((await outcomeOf(Promise.reject(new Unavailable(H, "control", "send", "timed out")))).status).toBe("possibly-sent");
  expect((await outcomeOf(Promise.reject(new Error("anything")))).status).toBe("possibly-sent");
});

test("a proven refusal is unsent whatever its class; an ordinary connection error stays possibly sent", async () => {
  expect((await outcomeOf(Promise.reject(new NotSent("refused before it was written")))).status).toBe("unsent");
  expect((await outcomeOf(Promise.reject(Object.assign(new Error("closed"), { code: "ECONNRESET" })))).status).toBe("possibly-sent");
  expect((await outcomeOf(Promise.reject("a thrown string"))).status).toBe("possibly-sent");
});

test("a request that was refused or never written did not send its input; one never answered may have", () => {
  expect(inputFailure(H, "send", "unsent", "x")).toBeInstanceOf(InputNotSent);
  expect(inputFailure(H, "send", "refused", "x")).toBeInstanceOf(InputNotSent);
  expect(inputFailure(H, "send", "uncertain", "x")).toBeInstanceOf(InputPossiblySent);
});
