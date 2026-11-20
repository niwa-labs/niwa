/**
 * The conformance suite of the reading side.
 *
 * A third party writes a reading side for a new harness, runs this suite, and it counts as
 * compatible. The suite knows no harness format: the kind writes four small synthetic sessions
 * (fixtures.ts) and the suite checks what the side makes of them.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireAbility, supports } from "../capabilities.ts";
import type { ReadingCapabilities } from "../capabilities.ts";
import type { Harness } from "../instance.ts";
import type { Coverage, Locator, SessionId, SessionReading, SessionRecord } from "../reading.ts";
import { sameSession } from "../reading.ts";

import { SCENARIOS } from "./fixtures.ts";
import type { FixtureResult, FixtureWriter, Scenario } from "./fixtures.ts";

/** The outcome of one check. */
export interface ConformanceResult {
  readonly name: string;
  readonly passed: boolean;
  /** What was found, when it failed. */
  readonly detail?: string;
}

/** The report of a suite, the same for every side. */
export interface ConformanceReport {
  /** The name of the kind that was checked. */
  readonly kind: string;
  readonly results: readonly ConformanceResult[];
  readonly passed: boolean;
}

/** Records a check. Shared by the suites of all three sides. */
export type Check = (name: string, passed: boolean, detail?: string) => void;

/** A collector of checks and the report it makes. */
export function collector(kind: string): {
  readonly check: Check;
  readonly report: () => ConformanceReport;
} {
  const results: ConformanceResult[] = [];
  return {
    check: (name, passed, detail) => {
      results.push(passed || detail === undefined ? { name, passed } : { name, passed, detail });
    },
    report: () => ({ kind, results, passed: results.every((result) => result.passed) }),
  };
}

/** Runs a call of the side; a throw is a failed check, not a crash of the suite. */
export async function attempt<T>(name: string, check: Check, call: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await call();
    check(name, true);
    return value;
  } catch (error) {
    check(name, false, describe(error));
    return undefined;
  }
}

/** The reading side under test, and the installation that declares it. */
export interface ConformanceSides {
  readonly instance: Harness;
  readonly reading: SessionReading;
}

/**
 * The suite of a reading side.
 *
 * The writer puts a scenario's fixtures into a directory the suite made, then `open` is given
 * that directory and returns the side bound to it: the side must find the fixtures there.
 */
export function readingConformance(
  kind: string,
  open: (dir: string) => ConformanceSides,
  writer: FixtureWriter,
): () => Promise<ConformanceReport> {
  return async () => {
    const { check, report } = collector(kind);
    let instance: Harness | undefined;
    let reading: SessionReading | undefined;

    for (const scenario of SCENARIOS) {
      const dir = await mkdtemp(join(tmpdir(), `niwa-conformance-${scenario}-`));
      try {
        const written = await writer(dir, scenario);
        const sides = open(dir);
        instance = sides.instance;
        reading = sides.reading;
        const declared = supports(instance, "reading", "list") && supports(instance, "reading", "read");
        check(`${scenario}: the side declares it can list and read`, declared);
        if (!declared) continue;
        await checkScenario(scenario, sides, written, check);
      } catch (error) {
        check(`${scenario}: the suite ran to the end`, false, describe(error));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    if (instance !== undefined && reading !== undefined) checkDeclarations({ instance, reading }, check);
    return report();
  };
}

async function checkScenario(
  scenario: Scenario,
  { reading }: ConformanceSides,
  written: FixtureResult,
  check: Check,
): Promise<void> {
  const { session } = written;
  const at = (what: string): string => `${scenario}: ${what}`;

  // The list finds the session.
  const listed: SessionId[] = [];
  for await (const info of reading.list()) listed.push(info.id);
  check(
    at("the list finds the session"),
    listed.some((id) => sameSession(id, session)),
    `the list holds ${listed.map((id) => `${id.harness}/${id.native}`).join(", ") || "nothing"}`,
  );

  // A session with records that nobody has read is "not scanned", never "empty".
  await checkCoverageIs(at("a session never read is not-scanned"), reading, "not-scanned", check, session);

  const first = await readAll(reading, session);
  const finished = scenario === "running" ? await checkRunning(reading, written, first, check) : first;

  // The common kinds, in the final state of the session.
  const kinds = new Set<string>(finished.map((record) => record.kind));
  check(
    at("the common kinds come back"),
    kinds.has("user") && kinds.has("assistant"),
    `the kinds are ${[...kinds].join(", ") || "none"}`,
  );
  check(at("every record is whole"), finished.every((record) => !record.incomplete));
  check(
    at("locators are distinct"),
    new Set(finished.map((record) => record.locator)).size === finished.length,
  );

  switch (scenario) {
    case "nested": {
      const nested = finished.find((record) => record.kind === "nested");
      check(
        at("the nested session is the child"),
        nested?.kind === "nested" && written.child !== undefined && sameSession(nested.child, written.child),
        nested === undefined ? "no nested record came back" : "the nested record names another session",
      );
      break;
    }
    case "compaction": {
      const compaction = finished.find((record) => record.kind === "compaction");
      check(
        at("the compaction keeps the summary"),
        compaction?.kind === "compaction" && compaction.summary === written.summary,
        compaction === undefined ? "no compaction record came back" : "the summary differs",
      );
      break;
    }
    case "broken":
      await checkUnknown(reading, session, finished, check);
      break;
    case "running":
      break;
  }

  // Reading from the locator of any record yields exactly what follows it.
  let resumed = true;
  let resumeDetail: string | undefined;
  for (const [index, record] of finished.entries()) {
    const after = (await readFrom(reading, session, record.locator)).map((r) => r.locator);
    const expected = finished.slice(index + 1).map((r) => r.locator);
    if (after.length !== expected.length || after.some((locator, i) => locator !== expected[i])) {
      resumed = false;
      resumeDetail = `from record ${index} the side gave ${after.length} records, expected ${expected.length}`;
      break;
    }
  }
  check(at("reading from a locator yields what follows"), resumed, resumeDetail);

  // The four coverage states are four different answers: not-scanned above, then these.
  const last = finished[finished.length - 1];
  if (last !== undefined) {
    await checkCoverageIs(at("a range read and empty is empty"), reading, "empty", check, session, last.locator);
  }
  await written.makeUnreadable();
  await checkCoverageIs(at("a session that cannot be scanned is failed"), reading, "failed", check, session);
  await written.remove();
  await checkCoverageIs(at("a session whose file is gone is unavailable"), reading, "unavailable", check, session);
}

/**
 * The half-written last line. Returns the records of the session once the line is whole.
 *
 * Before: whole records, then only marked ones at the end. After the writer completes the line:
 * reading from the last whole record gives the finished line, and nothing before it changed.
 */
async function checkRunning(
  reading: SessionReading,
  written: FixtureResult,
  before: readonly SessionRecord[],
  check: Check,
): Promise<readonly SessionRecord[]> {
  const { session } = written;
  const firstMarked = before.findIndex((record) => record.incomplete);
  const whole = firstMarked < 0 ? before : before.slice(0, firstMarked);
  const tail = firstMarked < 0 ? [] : before.slice(firstMarked);

  check("running: the half-written last line is marked incomplete", tail.length > 0);
  check(
    "running: nothing whole comes after the half-written line",
    tail.every((record) => record.incomplete),
  );
  check("running: whole records come before the half-written line", whole.length > 0);

  if (written.finish === undefined) {
    check("running: the fixture can finish the line", false, "the writer gave no finish");
    return before;
  }
  await written.finish();
  const after = await readAll(reading, session);

  check("running: once the line is whole nothing is marked", after.every((record) => !record.incomplete));
  check(
    "running: the records before the half-written line did not change",
    whole.every((record, index) => after[index]?.locator === record.locator && after[index]?.kind === record.kind),
  );
  const anchor = whole[whole.length - 1];
  if (anchor !== undefined) {
    const resumed = await readFrom(reading, session, anchor.locator);
    check(
      "running: reading continues from the last whole record",
      resumed.length > 0 &&
        resumed.every((record) => !record.incomplete) &&
        resumed.length === after.length - whole.length,
      `${resumed.length} records came back, ${after.length - whole.length} expected`,
    );
  }
  return after;
}

/** An unfamiliar whole line is "unknown" with its raw data, and reading does not stop at it. */
async function checkUnknown(
  reading: SessionReading,
  session: SessionId,
  records: readonly SessionRecord[],
  check: Check,
): Promise<void> {
  const unknown = records.find((record) => record.kind === "unknown");
  check("broken: the unfamiliar line comes back as unknown", unknown !== undefined);
  if (unknown?.kind !== "unknown") return;
  check("broken: the unknown record keeps its raw data", unknown.raw !== undefined);
  const raw = await reading.raw(session, unknown.locator);
  check("broken: raw gives the harness's own record", raw !== undefined && reading.rawSchema.safeParse(raw).success);
}

/** The refusals: what a side declares it implements, and what it does not it is refused. */
function checkDeclarations({ instance, reading }: ConformanceSides, check: Check): void {
  const watching = supports(instance, "reading", "watch");
  check(
    "refusal: watch is declared exactly when it is implemented",
    watching === (typeof reading.watch === "function"),
    watching ? "watch is declared but not implemented" : "watch is implemented but not declared",
  );
  for (const ability of ["list", "read", "watch"] as const satisfies readonly (keyof ReadingCapabilities)[]) {
    if (supports(instance, "reading", ability)) continue;
    let refusal: unknown;
    try {
      requireAbility(instance, "reading", ability);
    } catch (error) {
      refusal = error;
    }
    check(
      `refusal: ${ability} is refused by name when it is not declared`,
      refusal instanceof Error && refusal.name === "Unsupported",
    );
  }
}

async function checkCoverageIs(
  name: string,
  reading: SessionReading,
  expected: Coverage["status"],
  check: Check,
  session: SessionId,
  from?: Locator,
): Promise<void> {
  const coverage = await reading.coverage(session, from);
  check(name, coverage.status === expected, `the coverage says ${coverage.status}`);
}

async function readAll(reading: SessionReading, id: SessionId): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for await (const record of reading.read(id)) records.push(record);
  return records;
}

async function readFrom(reading: SessionReading, id: SessionId, from: Locator): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for await (const record of reading.read(id, from)) records.push(record);
  return records;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
