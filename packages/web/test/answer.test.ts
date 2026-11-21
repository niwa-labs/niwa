// The web surface answers a request of the owner: open requests and paused work are on the page,
// and answering from the page continues the waiting invocation.
//
// The paused invocation is covered in feed.test.ts. This is the open request: the
// executor asks the owner a question, and the page is what waits for the answer.
//
// A real host, a real web surface, and real HTTP requests:
//
//   1. the host is started with the requests module; the executor asks the owner a question
//   2. the open request is on the feed of the page: the page is what waits for the owner
//   3. POST /answer answers it — the body of the page names the request, the action wants the
//      id of the request and the answer itself
//   4. the answer stands, and the waiting work goes on with the answer it got
//   5. an answer that comes after the deadline does not stand: the page is told why
//
// The web surface is a client of the host, and it speaks for the owner: it is configured with
// speaksFor, so it connects with the owner's token and the host lets it answer. Nothing is written into the
// journal by the surface itself: the answer goes through the core's own action.
//
// Only public entries are used: the core and the testing helpers.

import { expect, test } from "bun:test";

import { owner, record } from "@niwa-labs/core";
import type { StoredRecord, Timestamp } from "@niwa-labs/core";
import { createNiwa, Deadline, eventually, tempHome, loginWeb, plugin, watch, webFetch, connectAsOwner, opt, pick, answeredBy, requestAsk, question, requests } from "@niwa-labs/testing";
import { z } from "zod";

import type { WebServer } from "../src/index.ts";
import { serveWebPages } from "./fixtures/serve-web.ts";

/** The record the test writes: it wakes the executor, which asks the owner. */
const Start = record(
  "answer.start",
  z.object({ release: z.string(), deadline: Deadline.optional(), other: z.boolean().optional() }),
  { open: true },
);

/** The work that continues once the answer has arrived. */
const Answered = record("answer.answered", z.object({ release: z.string(), branch: z.enum(["main", "next"]) }));

/** The question the executor asks the owner. */
const ReleaseBranch = question("answer.release.branch", { kind: "choice", title: "Which branch?", options: [opt("main"), opt("next")] });

/** The executor: it asks the owner, and waits for the answer. */
function executor() {
  return plugin("answer-executor", (api) => {
    api.declare(Start, Answered);
    api.on(Start, async (data, step) => {
      const { answer: raw } = answeredBy(
        await step(requestAsk, {
          to: data.other === true ? { kind: "client", id: "someone-else" } : owner,
          ...ReleaseBranch,
          input: { ...ReleaseBranch.input, detail: data.release },
          ...(data.deadline === undefined ? {} : { deadline: data.deadline }),
        }),
      );
      await step.emit(Answered, { release: data.release, branch: "ids" in raw && raw.ids[0] === "next" ? "next" : "main" });
    });
  });
}

/** One thing on the feed of the page. */
interface FeedEntry {
  kind: string;
  id: string;
  record: string;
  text: string;
  choices: string[];
}

/** What the page answers with: whether the answer stands, and why it does not. */
interface Verdict {
  accepted: boolean;
  reason?: string;
}

/** Read the feed of the page, as the server answers it. */
async function readFeed(url: string): Promise<FeedEntry[]> {
  const response = await webFetch(`${url}/feed`);
  expect(response.status).toBe(200);
  return (await response.json()) as FeedEntry[];
}

/** Answer a request from the page: the body of the page names the request it answers. */
async function answer(url: string, request: string, value: unknown): Promise<{ status: number; verdict: Verdict }> {
  const response = await webFetch(`${url}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request, answer: value }),
  });
  return { status: response.status, verdict: (await response.json()) as Verdict };
}

/** The records of one type, as the observer saw them. */
function of(seen: StoredRecord[], type: string): StoredRecord[] {
  return seen.filter((record) => record.type === type);
}

test("the answer: the page answers a request of the owner, and the work that waited goes on", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests());
  host.use(executor());
  await host.serve();

  let web: WebServer | undefined;
  const writer = await connectAsOwner(home.path);
  const observer = await watch(home.path);
  const seen = observer.seen;

  try {
    web = await serveWebPages({ home: home.path, port: 0, speaksFor: "owner" });
    await loginWeb(web);

    // The executor asks the owner a question.
    await writer.emit(Start, { release: "1.0" });
    await eventually(() => of(seen, "request.created").length === 1, 10_000, "the request was not made");
    const id = (of(seen, "request.created")[0]?.data as { id: string }).id;

    // The open request is on the page: the page is what waits for the owner.
    await eventually(
      async () => (await readFeed(web!.url)).some((entry) => entry.kind === "request" && entry.id === id),
      10_000,
      "the request did not reach the feed",
    );
    const entry = (await readFeed(web.url)).find((item) => item.kind === "request");
    expect(entry?.id).toBe(id);
    // The entry names the record it came from, so the page can link to it.
    expect(entry?.record).toBe(of(seen, "request.created")[0]?.id);
    expect(of(seen, "request.answered")).toHaveLength(0);

    // The page answers it: the answer stands, and the page is told that it does.
    const answered = await answer(web.url, id, pick("next"));
    expect(answered.status).toBe(200);
    expect(answered.verdict.accepted).toBe(true);
    expect(answered.verdict.reason).toBeUndefined();

    // The waiting work goes on with the answer the page gave.
    await eventually(() => of(seen, "answer.answered").length === 1, 10_000, "the work did not continue");
    expect(of(seen, "answer.answered")[0]?.data).toEqual({ release: "1.0", branch: "next" });
    expect(of(seen, "request.answered")).toHaveLength(1);
    expect((of(seen, "request.answered")[0]?.data as { by: unknown }).by).toEqual(owner);

    // The request is not on the page any more: it was answered.
    await eventually(async () => !(await readFeed(web!.url)).some((item) => item.id === id), 10_000);
  } finally {
    await web?.close();
    await writer.close();
    await observer.stop();
    await host.close();
    await home.cleanup();
  }
}, 30_000);

test("the answer: an answer that comes after the deadline does not stand, and the page is told why", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests());
  host.use(executor());
  await host.serve();

  let web: WebServer | undefined;
  const writer = await connectAsOwner(home.path);
  const observer = await watch(home.path);
  const seen = observer.seen;

  try {
    web = await serveWebPages({ home: home.path, port: 0, speaksFor: "owner" });
    await loginWeb(web);

    // The question is asked with a deadline that is still ahead.
    const deadline = (Date.now() + 500) as Timestamp;
    await writer.emit(Start, { release: "2.0", deadline });
    await eventually(() => of(seen, "request.created").length === 1, 10_000, "the request was not made");
    const id = (of(seen, "request.created")[0]?.data as { id: string }).id;

    // The time runs out: the request expires.
    await eventually(() => of(seen, "request.expired").length === 1, 10_000, "the request did not expire");

    // The answer comes too late: it does not stand, and the page is told why.
    const late = await answer(web.url, id, pick("main"));
    expect(late.status).toBe(200);
    expect(late.verdict.accepted).toBe(false);
    expect(late.verdict.reason).toBe("expired");

    // Nothing was written: the answer did not stand.
    expect(of(seen, "request.answered")).toHaveLength(0);
    expect(of(seen, "answer.answered")).toHaveLength(0);
  } finally {
    await web?.close();
    await writer.close();
    await observer.stop();
    await host.close();
    await home.cleanup();
  }
}, 30_000);

test("the feed: a request to someone else is not on the page", async () => {
  const home = await tempHome();
  const host = createNiwa({ home: home.path });
  host.use(requests());
  host.use(executor());
  await host.serve();

  let web: WebServer | undefined;
  const writer = await connectAsOwner(home.path);
  const observer = await watch(home.path);
  const seen = observer.seen;

  try {
    web = await serveWebPages({ home: home.path, port: 0, speaksFor: "owner" });
    await loginWeb(web);

    await writer.emit(Start, { release: "3.0", other: true });
    await writer.emit(Start, { release: "3.1" });
    await eventually(() => of(seen, "request.created").length === 2, 10_000, "the requests were not made");
    const created = of(seen, "request.created").map((item) => item.data as { id: string; to: { kind: string } });
    const mine = created.find((item) => item.to.kind === "owner")?.id;
    const theirs = created.find((item) => item.to.kind !== "owner")?.id;

    await eventually(
      async () => (await readFeed(web!.url)).some((entry) => entry.id === mine),
      10_000,
      "the request of the owner did not reach the feed",
    );
    expect((await readFeed(web.url)).some((entry) => entry.id === theirs)).toBe(false);

    // The page speaks for the owner, not for the one the other request was asked of.
    const refused = await webFetch(`${web.url}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: theirs, answer: "main" }),
    });
    expect(refused.status).toBe(409);
    expect(of(seen, "request.answered")).toHaveLength(0);
  } finally {
    await web?.close();
    await writer.close();
    await observer.stop();
    await host.close();
    await home.cleanup();
  }
}, 30_000);
