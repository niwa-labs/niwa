// The host program for the scenario "causes".
//
// The plugin declares three record types:
//
//   Seed { n }     — the original input: the root of the chain
//   Report { n }   — a report: it grows from the Seed
//   Merged { n }   — a result merged from the reports
//   Done { n }     — written by a handler woken by Merged
//
// The handler of Seed writes two reports with step.emit, then one merged result
// that declares links to all three inputs: the Seed and the two reports. A
// merged result depends on more than one thing, and `cause` can hold only one of
// them, so the other two are links.
//
// The home directory comes from argv[2]. The test imports this file for the
// record types, so the host only starts when the file is run directly.

import { createNiwa } from "@niwa-labs/host";
import { plugin } from "@niwa-labs/plugin";
import { record } from "@niwa-labs/core";
import { z } from "zod";

/** The original input: the root of the chain. */
export const Seed = record("causes.seed", z.object({ n: z.number() }), { open: true });

/** A report: it grows from the seed. */
export const Report = record("causes.report", z.object({ n: z.number() }));

/** A result merged from three inputs. */
export const Merged = record("causes.merged", z.object({ n: z.number() }));

/** Written by a handler woken by a handler's own record: the chain goes two levels down. */
export const Done = record("causes.done", z.object({ n: z.number() }));

/** The data of a report, read back from the record that holds it. */
const ReportData = z.object({ n: z.number() });

/** The plugin of this scenario. It needs no home: nothing of it counts effects. */
export function makePlugin() {
  return plugin("causes", (api) => {
    api.declare(Seed, Report, Merged, Done);
    api.on(Seed, async (data, step, record) => {
      // Two reports, both caused by the seed.
      const first = await step.emit(Report, { n: data.n + 1 });
      const second = await step.emit(Report, { n: data.n + 2 });

      // The merged result: its cause is the seed (the waking record), and it
      // declares links to all three inputs it depends on.
      await step.emit(
        Merged,
        {
          n: data.n + ReportData.parse(first.data).n + ReportData.parse(second.data).n,
        },
        { links: [record.id, first.id, second.id] },
      );
    });
    // Woken by the merged result: its cause is that record, its root is still the seed.
    api.on(Merged, async (data, step) => {
      await step.emit(Done, { n: data.n });
    });
  });
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    console.error("usage: bun causes-host.ts <home>");
    process.exit(2);
  }

  const niwa = createNiwa({ home });
  niwa.use(makePlugin());
  await niwa.serve();

  process.on("SIGTERM", () => {
    void niwa.close().then(() => process.exit(0));
  });
}
