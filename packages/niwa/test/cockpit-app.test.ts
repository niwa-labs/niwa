// The cockpit app in a real browser: the built app, the web surface and a host with the base plugins.
//
//   1. the app starts: the import map shares one React with the modules the host lists, and the plugins' pages are loaded
//   2. the home page shows the runs in blocks by directory, each block naming its directory
//   3. a run page shows the phase plan, and the recompute control asks in place before it acts
//   4. an open question is answered from the requests page
//   5. the tasks page lists a task and shows its contract; the sessions page opens
//   6. nothing the page does is refused by its content security policy, and no script fails
//
// Skipped when the machine has no headless Chromium (see fixtures/browser.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildCockpit, cockpitApp } from "@niwa-labs/cockpit";
import { requestAsk, requestGet, requests } from "@niwa-labs/requests";
import { RequestAnswered } from "@niwa-labs/requests/records";
import { baseStack, connectAsOwner, createNiwa, eventually, tempHome } from "@niwa-labs/testing";
import type { Host } from "@niwa-labs/testing";
import { taskCreate } from "@niwa-labs/tasks";
import { workflow, workflowCancel, workflowInspect, workflowStart, workflowWait } from "@niwa-labs/workflow";
import type { WebServer } from "@niwa-labs/web";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, ConsoleMessage, Page } from "playwright-core";

import { NOTICE_PAGES, serveCockpit } from "../src/web.ts";
import { chromiumPath } from "./fixtures/browser.ts";

const executable = chromiumPath();
const run = executable === undefined ? describe.skip : describe;

run("the cockpit app in a browser", () => {
  let host: Host;
  let web: WebServer;
  let browser: Browser;
  let workDir: string;
  let cleanup: () => Promise<void>;
  let session: Awaited<ReturnType<BrowserContext["storageState"]>>;
  const problems: string[] = [];

  beforeAll(async () => {
    const home = await tempHome();
    workDir = home.path;
    const site = join(home.path, "site");
    await buildCockpit({ outDir: site });
    host = createNiwa({ home: home.path });
    host.use(...baseStack().plugins.filter((plugin) => plugin.name !== "requests"), requests(), workflow());
    await host.serve();

    const script = join(home.path, "ship.js");
    await mkdir(home.path, { recursive: true });
    await writeFile(
      script,
      `export default workflow({ phases: [{ title: "Plan" }, { title: "Build" }], output: z.string() }, async () => {
        phase("Plan");
        await now({ label: "plan" });
        phase("Build");
        return (await ask.confirm("Ship it?")) ? "shipped" : "held";
      });`,
    );
    const other = join(home.path, "plain.js");
    await writeFile(other, `export default workflow({ output: z.string() }, async () => { await now({ label: "tick" }); return "done"; });`);
    await host.call(workflowStart, { file: script, directory: "/work/alpha", label: "ship" });
    await host.call(workflowStart, { file: other, directory: "/work/beta", label: "plain" });
    await host.call(workflowStart, { file: other, directory: "/work/alpha", label: "plain-again" });

    await host.call(taskCreate, {
      kind: "change",
      description: "Move argument parsing",
      text: "Move the parsing of arguments into the cli package.",
      askedBy: { kind: "owner" },
      responsible: { kind: "agent", id: "rin" },
      reportTo: { kind: "owner" },
    });

    web = await serveCockpit({ home: home.path, port: 0, pages: NOTICE_PAGES, speaksFor: "owner", app: await cockpitApp({ root: site }) });
    browser = await chromium.launch({ executablePath: executable });
    // The login link works once: log in once and let every page of the tests carry the cookie.
    const login = await browser.newContext();
    await (await login.newPage()).goto(web.loginUrl, { waitUntil: "load" });
    session = await login.storageState();
    await login.close();
    cleanup = async () => {
      await browser.close();
      await web.close();
      await host.close();
      await home.cleanup();
    };
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  /** What the content security policy of the page refused so far. */
  async function violations(page: Page): Promise<string[]> {
    return (await page.evaluate("window.__violations")) as string[];
  }

  async function open(path = "/"): Promise<Page> {
    const context = await browser.newContext({ storageState: session });
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    await page.addInitScript(`
      window.__violations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__violations.push(event.violatedDirective + " " + event.blockedURI);
      });
    `);
    await page.goto(`${web.url}${path}`, { waitUntil: "load" });
    return page;
  }

  test("the desk shows the four states, filters both projects and opens the workflow catalogue", async () => {
    const page = await open();
    await page.waitForSelector(".desk-strip button[data-kind=decision]");
    const waiting = page.locator('[data-slot="run-row"]').filter({has:page.locator('a[href^="/requests/"]')}).first();
    await waiting.locator(".nw-track").waitFor();
    expect(await waiting.locator(".nw-sequence").count()).toBe(0);
    expect(await waiting.locator('a[href^="/requests"]').count()).toBe(1);
    await page.getByLabel("Проект", { exact: true }).selectOption("/work/beta");
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="run-row"]').length === 1);
    expect(await page.locator('[data-slot="run-row"]').innerText()).toContain("plain");
    expect(await page.locator(".desk-strip button").count()).toBe(4);
    await page.getByText("Каталог сценариев", { exact: true }).click();
    await page.waitForSelector('[data-slot="workflows"]');
    expect(await page.getByRole("heading", { name: "Зарегистрированные сценарии" }).count()).toBe(1);
    await page.context().close();
  }, 60_000);

  test("the runs page keeps the directory view", async () => {
    const page = await open("/runs");
    await page.waitForSelector('[data-slot="run-block"]');
    const blocks = await page.$$eval('[data-slot="run-block"]', (nodes) => nodes.map((node) => ({ directory: node.getAttribute("data-directory"), runs: node.querySelectorAll('[data-slot="run-row"]').length })));
    expect(blocks.sort((a, b) => (a.directory ?? "").localeCompare(b.directory ?? ""))).toEqual([
      { directory: "/work/alpha", runs: 2 },
      { directory: "/work/beta", runs: 1 },
    ]);
    // The directory is written in its block.
    expect(await page.textContent('[data-directory="/work/alpha"] header')).toContain("/work/alpha");
    // The navigation has the pages the modules added.
    const links = await page.$$eval('nav[aria-label="Pages"] a', (nodes) => nodes.map((node) => node.textContent));
    expect(links).toEqual(expect.arrayContaining(["Пульт", "Сценарии", "Запуски", "Сессии", "Запросы", "Задачи"]));
    expect(await violations(page)).toEqual([]);
    await page.context().close();
  }, 60_000);

  test("a run page shows its plan, and the controls ask in place before they act", async () => {
    const page = await open();
    await page.waitForSelector('[data-slot="run-row"]');
    await page.click('[data-slot="run-row"] a:has-text("ship")');
    await page.getByText("Управление фазами и шагами", { exact: true }).click();
    await page.waitForSelector('[data-slot="phase-plan"]');
    expect(await page.locator('[data-slot="run-directory"] button').getAttribute('title')).toBe("/work/alpha");
    const phases = await page.$$eval('[data-slot="plan-phase"]', (nodes) => nodes.map((node) => node.querySelector("span.truncate")?.textContent));
    expect(phases).toEqual(["Plan", "Build"]);
    // The run waits for an answer, so the current phase may be stopped and nothing may be recomputed under it.
    const stop = page.locator('[data-slot="plan-phase"] [data-slot="guard-button"][aria-label="Stop"]');
    await stop.first().click();
    expect(await page.textContent('[data-slot="phase-plan"]')).toContain("Ends the whole run");
    await page.keyboard.press("Escape");
    await page.context().close();
  }, 60_000);

  test("a run is stopped from its page: the second press starts a countdown that can be undone, and the run ends when it runs out", async () => {
    const file = join(workDir, "hold.js");
    await writeFile(file, `export default workflow({ phases: [{ title: "Hold" }], output: z.string() }, async () => { phase("Hold"); return (await ask.confirm("Hold on?")) ? "yes" : "no"; });`);
    const { run } = await host.call(workflowStart, { file, directory: "/work/gamma", label: "hold" });
    const page = await open(`/runs/${run}`);
    await page.getByText("Управление фазами и шагами", { exact: true }).click();
    await page.waitForSelector('[data-slot="plan-phase"] [aria-label="Stop"]');
    const stop = page.locator('[aria-label="Stop"]').first();
    const notice = page.locator('[data-slot="guard-notice"]');

    await stop.click();
    await notice.waitFor();
    expect(await notice.getAttribute("data-phase")).toBe("armed");
    await stop.click();
    await page.waitForSelector('[data-slot="guard-notice"][data-phase="pending"]');
    // Undone in time: nothing is stopped.
    await page.click('[data-slot="guard-notice"] button:has-text("Undo")');
    await page.waitForSelector('[data-slot="guard-notice"]', { state: "detached" });
    expect(await page.textContent('[data-slot="run-page"]')).not.toContain("Остановлен");

    await stop.click();
    await stop.click();
    await page.waitForSelector("text=Остановлен", { timeout: 15_000 });
    await page.context().close();
  }, 60_000);

  test("a finished run is computed again from its page, with the same two presses", async () => {
    const file = join(workDir, "plain.js");
    const { run } = await host.call(workflowStart, { file, directory: "/work/delta", label: "again" });
    await host.call(workflowWait, { run, timeoutMs: 10_000 });
    const before = (await host.call(workflowInspect, { run })).origin.requestedAt;
    const page = await open(`/runs/${run}`);
    await page.getByText("Управление фазами и шагами", { exact: true }).click();
    const recompute = page.locator('[aria-label="Recompute from here"]').first();
    await recompute.waitFor();
    await recompute.click();
    await page.waitForSelector('[data-slot="guard-notice"][data-phase="armed"]');
    const warning = await page.textContent('[data-slot="guard-notice"]');
    expect(warning).toContain("Restart the run from the top");
    expect(warning).toContain("may repeat a message or another external change");
    expect((await host.call(workflowInspect, { run })).origin.requestedAt).toBe(before);
    await recompute.click();
    await page.waitForSelector('[data-slot="guard-notice"][data-phase="pending"]');
    await eventually(async () => (await host.call(workflowInspect, { run })).origin.requestedAt !== before, 15_000, "the run should have been asked for again");
    expect((await host.call(workflowWait, { run, timeoutMs: 10_000 })).outcome).toMatchObject({ status: "done", result: "done" });
    await page.context().close();
  }, 60_000);

  test("an open question is answered from the requests page", async () => {
    const page = await open("/requests");
    await page.waitForSelector('[data-slot="request"]');
    expect(await page.textContent('[data-slot="request"]')).toContain("Ship it?");
    await page.click('[data-slot="request"] button[aria-pressed]:first-of-type');
    await page.click('[data-slot="request"] button[type="submit"]');
    await page.waitForSelector('text=Запросов без ответа нет.');
    await page.context().close();
  }, 60_000);

  test("the owner overrides an ordinary judge question from its card", async () => {
    const { id } = await host.call(requestAsk, {
      to: { kind: "agent", id: "judge" }, question: "fixture.judge", input: { kind: "text", title: "Which branch?" },
    });
    const page = await open("/requests");
    try {
      const card = page.locator('[data-slot="request"]').filter({ hasText: "Which branch?" });
      await card.getByRole("textbox").fill("main");
      await card.getByRole("button", { name: "Ответить за адресата", exact: true }).click();
      await card.waitFor({ state: "detached" });
      expect(await host.call(requestGet, { id })).toMatchObject({ status: "answered", answer: { text: "main" } });
      const receipt = (await host.records.read({ types: [RequestAnswered.name] })).find((row) => RequestAnswered.schema.parse(row.data).id === id);
      expect(receipt).toMatchObject({ actor: { kind: "client", principal: { kind: "owner" }, issuedBy: "requests" }, data: { by: { kind: "owner" } } });
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("the tasks page lists a task, and its page shows the contract", async () => {
    const page = await open("/tasks");
    await page.waitForSelector('[data-slot="task-row"]');
    expect(await page.textContent('[data-slot="task-row"]')).toContain("Move argument parsing");
    await page.click('[data-slot="task-row"] a:has-text("Move argument parsing")');
    await page.waitForSelector('[data-slot="task-page"]');
    expect(await page.textContent('[data-slot="task-page"]')).toContain("Move the parsing of arguments");
    await page.context().close();
  }, 60_000);

  test("the sessions page opens, and says so when the host has none", async () => {
    const page = await open("/sessions");
    await page.waitForSelector("text=Сессий пока нет");
    await page.context().close();
  }, 60_000);

  test("an owner checks and registers a script, then fills its input schema and launches it", async () => {
    const file = join(workDir, "welcome.ts");
    await writeFile(file, 'export default workflow({description:"Welcome someone", input:z.object({ person:z.string() }), output:z.string()}, async ({person}) => "Hello " + person);');
    const page = await open("/workflows");
    await page.getByRole("link", { name: "Регистрация", exact: true }).click();
    await page.getByLabel("Файл сценария на хосте").fill(file);
    await page.getByRole("button", { name: "Проверить", exact: true }).click();
    await page.getByText("Проверка пройдена", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Зарегистрировать", exact: true }).click();
    await page.getByRole("status").getByRole("link", { name: "Welcome someone" }).click();
    await page.locator('[data-slot="workflow-detail"]').waitFor();
    await page.getByRole("link", { name: "▶ Запустить", exact: true }).click();
    await page.getByLabel("person").fill("Cockpit");
    await page.getByRole("button", { name: "▶ Запустить", exact: true }).click();
    await page.getByText("Hello Cockpit", { exact: true }).waitFor();
    await page.context().close();
  }, 60_000);

  test("the tasks page has a host-schema form that creates a task", async () => {
    const page = await open("/tasks");
    try {
      await page.getByRole("button", { name: "Создать задачу", exact: true }).click();
      const form = page.locator(".desk-commands form");
      await form.getByRole("textbox", { name: "kind", exact: true }).fill("review");
      await form.getByRole("textbox", { name: "description", exact: true }).fill("Review cockpit forms");
      await form.getByRole("textbox", { name: "text", exact: true }).fill("Check the generated form.");
      const responsible = form.getByRole("group", { name: "responsible", exact: true });
      await responsible.getByRole("combobox").selectOption({ label: "owner" });
      await form.getByRole("button", { name: "Создать задачу", exact: true }).click();
      await page.locator('[data-slot="task-row"]').filter({ hasText: "Review cockpit forms" }).waitFor();
      const created = (await host.records.read({ types: ["task.created"] })).at(-1);
      expect(created?.data).toMatchObject({
        kind: "review",
        description: "Review cockpit forms",
        text: "Check the generated form.",
        askedBy: { kind: "owner" },
        responsible: { kind: "owner" },
        reportTo: { kind: "owner" },
      });
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("all header phases are visible before the first phase entry", async () => {
    const file = join(workDir, "declared-plan.js");
    await writeFile(file, `export default workflow({
      phases: [{ title: "Read", detail: "Read three sources" }, { title: "Verify", detail: "Compare the findings" }]
    }, async () => {
      await ask.confirm("Begin reading?");
      phase("Read");
      await now();
      phase("Verify");
    });`);
    const { run } = await host.call(workflowStart, { file });
    const page = await open("/runs/" + run);
    try {
      const plan = page.getByRole("list", { name: "План фаз" });
      await plan.getByRole("button", { name: /Compare the findings/ }).waitFor();
      expect(await plan.locator("button").allTextContents()).toEqual(["○ReadRead three sources", "○VerifyCompare the findings"]);
      expect(await plan.locator('[data-state="pending"]').count()).toBe(2);
      await page.getByRole("region", { name: "Шаги вне фаз" }).getByRole("link", { name: /Ответить/ }).waitFor();
      await page.goto(web.url + "/runs");
      const row = page.locator('[data-slot="run-row"]').filter({has: page.locator('a[href="/runs/' + run + '"]')}).first();
      await row.getByLabel("Фазы").waitFor();
      expect(await row.getByLabel("Фазы").innerText()).toContain("Verify");
    } finally {
      await page.context().close();
      await host.call(workflowCancel, { run });
    }
  }, 60_000);

  test("parallel sleeps have independent countdowns and animated paths that honour reduced motion", async () => {
    const file = join(workDir, "parallel-timers.js");
    await writeFile(file, `export default workflow({phases:[{title:"Prepare"},{title:"Check"},{title:"Report"}]}, async () => {
      phase("Prepare"); await now();
      phase("Check"); await parallel([()=>sleep("1h",{label:"one"}),()=>sleep("2h",{label:"two"})]);
    });`);
    const { run } = await host.call(workflowStart, { file, label:"parallel timers" });
    const page = await open("/runs/"+run);
    try {
      await page.getByText("⑂ Параллельные ветки").waitFor();
      const clocks = page.locator(".nw-countdown");
      expect(await clocks.count()).toBe(2);
      expect(await clocks.first().getAttribute("datetime")).not.toBe(await clocks.last().getAttribute("datetime"));
      const previous = await clocks.first().textContent();
      await eventually(async () => await clocks.first().textContent() !== previous, 4000);
      const motion = () => page.evaluate<string[]>('document.getAnimations().map(a=>a.animationName).filter(n=>n?.startsWith("nw-"))');
      expect(await motion()).toEqual(expect.arrayContaining(["nw-breathe","nw-across","nw-down"]));
      await page.emulateMedia({ reducedMotion:"reduce" });
      expect(await motion()).toEqual([]);
      const plan = page.getByRole("list", { name: "План фаз" });
      expect(await plan.getByRole("button").count()).toBe(3);
      expect(await page.locator(".nw-step").count()).toBe(2);
      await plan.getByRole("button", { name: /Report/ }).click();
      await page.getByText("Фаза ещё не началась").waitFor();
      await plan.getByRole("button", { name: /Prepare/ }).click();
      expect(await page.locator(".nw-step").count()).toBe(1);
      await page.locator(".nw-step a").first().click();
      await page.locator('#record-title').filter({ hasText:"Начат шаг" }).waitFor();
      expect(await violations(page)).toEqual([]);
    } finally {
      await page.context().close();
      await host.call(workflowCancel, { run });
    }
  }, 60_000);

  test("one copy of React serves the app and the modules, and nothing was refused or failed", async () => {
    const page = await open("/runs");
    await page.waitForSelector('[data-slot="run-block"]');
    const shared = (await page.evaluate(`(async () => {
      const map = JSON.parse(document.querySelector('script[type="importmap"]').textContent);
      const [a, b] = await Promise.all([import(map.imports.react), import(map.imports.react)]);
      return { same: a === b, keys: Object.keys(map.imports) };
    })()`)) as { same: boolean; keys: string[] };
    expect(shared.same).toBe(true);
    expect(shared.keys).toEqual(expect.arrayContaining(["react", "react-dom", "@niwa-labs/cockpit-sdk", "@niwa-labs/ui-kit", "@tanstack/react-query"]));
    expect(await violations(page)).toEqual([]);
    await page.context().close();
    expect(problems).toEqual([]);
  }, 60_000);
});
