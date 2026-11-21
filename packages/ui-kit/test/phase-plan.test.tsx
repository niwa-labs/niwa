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

test("an explanation is worked out only for the control that shows it", async () => {
  const asked: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const phases: PhasePlanPhase[] = [
    {
      id: "build",
      title: "Build",
      state: "running",
      steps: [
        { id: "a", title: "A", state: "done" },
        { id: "b", title: "B", state: "done" },
      ],
    },
  ];
  await act(async () =>
    root.render(
      <TooltipProvider>
        <PhasePlan
          phases={phases}
          onRecompute={() => {}}
          onStop={() => {}}
          explainRecompute={(target) => {
            asked.push(`recompute ${target.step ?? target.phase}`);
            return "explained";
          }}
          explainStop={(target) => {
            asked.push(`stop ${target.step ?? target.phase}`);
            return "explained";
          }}
        />
      </TooltipProvider>,
    ),
  );
  expect(asked).toEqual([]);
  const first = host.querySelector<HTMLElement>('[data-slot="plan-step"] [data-slot="guard-button"]')!;
  await act(async () => {
    first.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });
  expect(asked.length).toBeGreaterThan(0);
  expect(new Set(asked)).toEqual(new Set(["recompute a"]));
  expect(host.textContent).toContain("explained");
  await act(async () => root.unmount());
});

test("arming a completed action warns before an external change can be repeated", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let confirmed = false;
  try {
    await act(async () => root.render(
      <TooltipProvider>
        <PhasePlan phases={[{ id: "ship", title: "Ship", state: "running", steps: [
          { id: "publish", title: "Publish", state: "done" },
        ] }]} onRecompute={() => { confirmed = true; }} />
      </TooltipProvider>,
    ));
    const control = host.querySelector<HTMLElement>('[data-slot="plan-step"] [data-slot="guard-button"]')!;
    await act(async () => {
      control.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });
    expect(host.querySelector('[data-slot="guard-notice"]')?.textContent).toContain("external changes may be repeated");
    expect(confirmed).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
