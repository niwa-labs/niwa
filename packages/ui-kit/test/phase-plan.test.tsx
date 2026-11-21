// A phase plan in a document, as its phases change state while the run goes on.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { PhasePlan, TooltipProvider, type PhasePlanPhase } from "../src/index.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  await GlobalRegistrator.unregister();
});

const phase = (state: PhasePlanPhase["state"]): PhasePlanPhase => ({ id: "build", title: "Build", state, steps: [{ id: "s", title: "Compile", state: state === "running" ? "running" : "done" }] });

test("a phase that settles while it is shown does not make its panel complain about a changed default", async () => {
  const complaints = spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const plan = (state: PhasePlanPhase["state"]) => (
    <TooltipProvider>
      <PhasePlan phases={[phase(state)]} />
    </TooltipProvider>
  );
  await act(async () => root.render(plan("running")));
  await act(async () => root.render(plan("done")));
  expect(complaints.mock.calls.map((call) => String(call[0]))).toEqual([]);
  complaints.mockRestore();
  await act(async () => root.unmount());
});

test("a phase is open while it runs, and the one who closed it keeps it closed when it settles", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const plan = (state: PhasePlanPhase["state"]) => (
    <TooltipProvider>
      <PhasePlan phases={[phase(state)]} />
    </TooltipProvider>
  );
  const expanded = (): string | null => host.querySelector('[data-slot="collapsible-trigger"]')!.getAttribute("aria-expanded");
  await act(async () => root.render(plan("running")));
  expect(expanded()).toBe("true");
  await act(async () => host.querySelector<HTMLElement>('[data-slot="plan-phase"] button')!.click());
  expect(expanded()).toBe("false");
  await act(async () => root.render(plan("done")));
  expect(expanded()).toBe("false");
  await act(async () => root.unmount());
});

test("a phase that settles closes by itself when nobody chose", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const plan = (state: PhasePlanPhase["state"]) => (
    <TooltipProvider>
      <PhasePlan phases={[phase(state)]} />
    </TooltipProvider>
  );
  await act(async () => root.render(plan("running")));
  await act(async () => root.render(plan("done")));
  expect(host.querySelector('[data-slot="collapsible-trigger"]')!.getAttribute("aria-expanded")).toBe("false");
  await act(async () => root.unmount());
});
