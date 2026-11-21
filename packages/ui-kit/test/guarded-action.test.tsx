// The guarded control in a document: real timers, short windows.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Activity, act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GuardButton, GuardNotice, TooltipProvider, useGuardedAction } from "../src/index.ts";

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

const timing = { armMs: 1000, holdMs: 40, undoMs: 60 };

function Control({ onConfirm, disabled }: { onConfirm: () => void; disabled?: boolean }) {
  const guard = useGuardedAction({ onConfirm, timing, disabled });
  return (
    <TooltipProvider>
      <GuardButton guard={guard} icon={<span>R</span>} label="Recompute from here" />
      <GuardNotice guard={guard} consequence="3 steps run again." pending="Recomputing" />
    </TooltipProvider>
  );
}

async function mount(onConfirm: () => void): Promise<{ root: Root; host: HTMLElement }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Control onConfirm={onConfirm} />));
  return { root, host };
}

function button(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('[data-slot="guard-button"]')!;
}

/** A keyboard activation: a click event with no pointer behind it. */
async function keyPress(host: HTMLElement): Promise<void> {
  await act(async () => {
    button(host).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("guarded action", () => {
  test("two presses explain, confirm, and fire once after the undo window", async () => {
    let fired = 0;
    const { root, host } = await mount(() => (fired += 1));
    await keyPress(host);
    expect(host.textContent).toContain("3 steps run again.");
    await keyPress(host);
    expect(host.textContent).toContain("Recomputing in 1s");
    expect(fired).toBe(0);
    await wait(120);
    expect(fired).toBe(1);
    expect(host.querySelector('[data-slot="guard-notice"]')).toBeNull();
    await act(async () => root.unmount());
    expect(fired).toBe(1);
  });

  test("undo during the window sends nothing", async () => {
    let fired = 0;
    const { root, host } = await mount(() => (fired += 1));
    await keyPress(host);
    await keyPress(host);
    const undo = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Undo"))!;
    await act(async () => undo.click());
    await wait(120);
    expect(fired).toBe(0);
    await act(async () => root.unmount());
    expect(fired).toBe(0);
  });

  test("a control that goes away during the undo window fires what was confirmed", async () => {
    let fired = 0;
    const { root, host } = await mount(() => (fired += 1));
    await keyPress(host);
    await keyPress(host);
    await act(async () => root.unmount());
    expect(fired).toBe(1);
  });

  test("Escape disarms", async () => {
    let fired = 0;
    const { root, host } = await mount(() => (fired += 1));
    await keyPress(host);
    await act(async () => {
      button(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[data-slot="guard-notice"]')).toBeNull();
    await act(async () => root.unmount());
    expect(fired).toBe(0);
  });

  test("the action fires for the target that was confirmed, not the one shown after", async () => {
    const fired: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (target: string) => <Control onConfirm={() => fired.push(target)} />;
    await act(async () => root.render(show("A")));
    await keyPress(host);
    await keyPress(host);
    await act(async () => root.render(show("B")));
    await wait(120);
    expect(fired).toEqual(["A"]);
    await act(async () => root.unmount());
    expect(fired).toEqual(["A"]);
  });

  test("a confirmed action fires for its own target when the control goes away", async () => {
    const fired: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (target: string) => <Control onConfirm={() => fired.push(target)} />;
    await act(async () => root.render(show("A")));
    await keyPress(host);
    await keyPress(host);
    await act(async () => root.render(show("B")));
    await act(async () => root.unmount());
    expect(fired).toEqual(["A"]);
  });

  test("a disabled control neither arms nor fires", async () => {
    let fired = 0;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Control onConfirm={() => (fired += 1)} disabled />));
    expect(button(host).disabled).toBe(true);
    await keyPress(host);
    await keyPress(host);
    await act(async () => {
      button(host).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await wait(120);
    expect(host.querySelector('[data-slot="guard-notice"]')).toBeNull();
    expect(fired).toBe(0);
    await act(async () => root.unmount());
    expect(fired).toBe(0);
  });

  test("an armed control whose availability is revoked disarms", async () => {
    let fired = 0;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Control onConfirm={() => (fired += 1)} />));
    await keyPress(host);
    expect(host.textContent).toContain("3 steps run again.");
    await act(async () => root.render(<Control onConfirm={() => (fired += 1)} disabled />));
    expect(host.querySelector('[data-slot="guard-notice"]')).toBeNull();
    await act(async () => root.render(<Control onConfirm={() => (fired += 1)} />));
    await keyPress(host);
    // Armed again from scratch: one more press only confirms, nothing was carried over.
    expect(host.textContent).toContain("3 steps run again.");
    expect(fired).toBe(0);
    await act(async () => root.unmount());
  });

  test("a hold hidden before it completes is not completed when the control is shown again", async () => {
    let fired = 0;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <Control onConfirm={() => (fired += 1)} />
      </Activity>
    );
    await act(async () => root.render(show("visible")));
    await act(async () => {
      button(host).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await act(async () => root.render(show("hidden")));
    await wait(120);
    await act(async () => root.render(show("visible")));
    await wait(120);
    expect(button(host).dataset.phase).toBe("idle");
    expect(fired).toBe(0);
    await act(async () => root.unmount());
    expect(fired).toBe(0);
  });

  test("the hook refuses gestures while disabled, whatever element carries its props", async () => {
    let fired = 0;
    const seen = new Set<string>();
    function Bare() {
      const guard = useGuardedAction({ onConfirm: () => (fired += 1), timing, disabled: true });
      const { disabled: _disabled, ...handlers } = guard.buttonProps;
      seen.add(guard.state.phase);
      return <span data-phase={guard.state.phase} {...handlers} />;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Bare />));
    const bare = host.querySelector<HTMLElement>("span")!;
    await act(async () => {
      bare.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    expect(bare.dataset.phase).toBe("idle");
    await act(async () => {
      bare.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });
    expect(bare.dataset.phase).toBe("idle");
    await act(async () => root.unmount());
    expect(fired).toBe(0);
    // Not even for a moment: the gesture is refused, not started and dropped again.
    expect([...seen]).toEqual(["idle"]);
  });
});
