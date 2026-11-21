/** The cockpit module of the workflow plugin: its runs on the home page, the list of runs and the page of one run. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { RunPage } from "./run-page.tsx";
import { Runs } from "./runs.tsx";

function RunsPage() {
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <h2 className="text-lg font-semibold">Runs</h2>
      <Runs />
    </div>
  );
}

function RunsTile() {
  return (
    <section data-slot="runs-tile" className="col-span-full flex min-w-0 flex-col gap-2">
      <h2 className="text-sm font-semibold text-muted-foreground">Runs</h2>
      <Runs limit={50} />
    </section>
  );
}

export default definePlugin({
  id: "workflow",
  setup(ctx) {
    ctx.pages.add({ path: "/runs", title: "Runs", nav: { order: 10 }, component: RunsPage });
    ctx.pages.add({ path: "/runs/$runId", title: "Run", component: RunPage });
    ctx.slots.register("home.tile", { key: "runs", order: 0, component: RunsTile });
    ctx.entities.register("run", { label: "Run", prefix: "run", href: (id) => `/runs/${encodeURIComponent(id)}` });
  },
});
