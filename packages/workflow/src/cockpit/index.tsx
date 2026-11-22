/** The cockpit module of the workflow plugin: its runs on the home page, the list of runs and the page of one run. */

import { definePlugin, PageLink, useViewer } from "@niwa-labs/cockpit-sdk";

import { RunPage } from "./run-page.tsx";
import { LaunchPage } from "./launch.tsx";
import { WorkflowCatalogue, WorkflowDetails } from "./workflows.tsx";
import { DashboardRuns, RunSummary } from "./dashboard.tsx";
import { Runs } from "./runs.tsx";

function RunsPage() {
  const viewer = useViewer();
  return (
    <div className="desk-page">
      <header className="desk-heading">
        <h1>Запуски по проектам</h1>
        <div className="desk-tools">
          <PageLink to="/workflows">Каталог сценариев</PageLink>
          {viewer.can("workflow.start") && (
            <PageLink className="desk-primary" to="/workflows/launch">
              ▶ Запустить workflow
            </PageLink>
          )}
        </div>
      </header>
      <Runs />
    </div>
  );
}

export default definePlugin({
  id: "workflow",
  setup(ctx) {
    ctx.pages.add({ path: "/runs", title: "Runs", nav: { order: 10 }, component: RunsPage });
    ctx.pages.add({ path: "/runs/$runId", panel: true, title: "Run", component: RunPage });
    ctx.pages.add({ path: "/workflows", title: "Сценарии", nav: { order: 9 }, component: WorkflowCatalogue });
    ctx.pages.add({ path: "/workflows/launch", panel: true, title: "Запустить workflow", component: LaunchPage });
    ctx.pages.add({ path: "/workflows/$workflowId", panel: true, title: "Сценарий", component: WorkflowDetails });
    if (ctx.viewer.can("workflow.runs")) {
      ctx.slots.register("home.summary", { key: "states", component: RunSummary });
      ctx.slots.register("home.main", { key: "runs", order: 0, component: DashboardRuns });
    }
    ctx.entities.register("workflow", {
      label: "Сценарий",
      prefix: "wf",
      href: (id) => "/workflows/" + encodeURIComponent(id),
    });
    ctx.entities.register("run", { label: "Run", prefix: "run", href: (id) => `/runs/${encodeURIComponent(id)}` });
  },
});
