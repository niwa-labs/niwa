/** One run: where it stands, and its plan of phases and steps with the controls to run it again or stop it. */

import { EntityLink, PageLink, useAction, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { PhasePlan, StateRing, formatAgo, formatDuration, type PhasePlanStep, type PlanTarget } from "@niwa-labs/ui-kit";

import { inspectAction, resumeAction, stopAction, type Inspection, type Step } from "./actions.ts";
import { planOf, recomputeOf, stepDuration, stepState, stopOf } from "./plan.ts";
import { ringOf } from "./runs.tsx";

function toStep(step: Step): PhasePlanStep {
  const took = stepDuration(step);
  return {
    id: step.id,
    title: step.label === "" ? step.action : step.label,
    state: stepState(step),
    ...(step.effect === true ? { effect: true } : {}),
    ...(took === undefined && step.reused !== true
      ? {}
      : { meta: [step.reused === true ? "from the run before" : undefined, took === undefined ? undefined : formatDuration(took)].filter(Boolean).join(" · ") }),
    ...(step.session === undefined && step.prompt === undefined
      ? {}
      : {
          detail: (
            <span className="flex min-w-0 items-center gap-2">
              {step.session === undefined ? null : <EntityLink entity={{ kind: "session", id: step.session }} short />}
              {step.prompt === undefined ? null : <span className="min-w-0 truncate">{step.prompt}</span>}
            </span>
          ),
        }),
  };
}

function RunSessions({ sessions }: { sessions: Inspection["sessions"] }) {
  if (sessions.length === 0) return null;
  const ids = new Map(sessions.map(({ id, ref }) => [ref, id]));
  return (
    <section aria-label="Run sessions" className="min-w-0 rounded-lg border bg-card text-card-foreground">
      <h3 className="border-b px-3 py-2 text-sm font-semibold">Run sessions</h3>
      <ul className="divide-y px-3" data-slot="run-sessions">
        {sessions.map(({ id, ref, parentSession, startedAt }) => {
          const parent = parentSession === undefined ? undefined : ids.get(parentSession);
          return (
            <li key={id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
              <EntityLink entity={{ kind: "session", id }} />
              <span className="min-w-0 truncate text-sm" title={ref}>{ref}</span>
              {parentSession === undefined ? null : (
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <span className="shrink-0">Started by</span>
                  {parent === undefined ? (
                    <span className="truncate" title={parentSession}>{parentSession}</span>
                  ) : (
                    <EntityLink entity={{ kind: "session", id: parent }} />
                  )}
                </span>
              )}
              <time className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={startedAt}>
                {formatAgo(startedAt)}
              </time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RunPage({ params }: PageProps<"/runs/$runId">) {
  const run = params.runId;
  const queryClient = useQueryClient();
  const inspection = useCall(inspectAction, { run }, { refreshOn: { types: ["workflow.*", "niwa.step.*", "niwa.invocation.state", "session.started"] } });
  const resume = useAction(resumeAction);
  const stop = useAction(stopAction);

  if (inspection.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading the run…</p>;
  if (inspection.isError) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <p role="alert" className="text-sm text-destructive">The run could not be read: {inspection.error.message}</p>
        <PageLink to="/runs" className="text-sm underline-offset-2 hover:underline">All runs</PageLink>
      </div>
    );
  }

  const { status, origin } = inspection.data;
  const phases = planOf(inspection.data, toStep);
  const current = phases.find((phase) => phase.state === "running" || phase.state === "waiting")?.id;
  const reread = (): void => void queryClient.invalidateQueries({ queryKey: ["niwa", "call"] });

  // A step or a phase runs again from where it is, the steps before it taken from the run as it was; a step stops on its
  // own and the run goes on, a phase row stops the whole run.
  const recompute = (target: PlanTarget): void => resume.mutate(recomputeOf(inspection.data, target), { onSettled: reread });
  const halt = (target: PlanTarget): void => stop.mutate(stopOf(inspection.data, target), { onSettled: reread });
  const failure = resume.error ?? stop.error;

  return (
    <article data-slot="run-page" className="flex min-w-0 flex-col gap-4 p-4">
      <header className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <StateRing state={ringOf(status.state)} label={status.state} />
          <h2 className="min-w-0 truncate text-lg font-semibold">{origin.label ?? origin.file.split("/").at(-1) ?? run}</h2>
          <EntityLink entity={{ kind: "run", id: run }} />
        </div>
        <p className="min-w-0 truncate text-xs text-muted-foreground" data-slot="run-directory">
          {origin.directory === undefined ? "No directory" : origin.directory}
        </p>
        <p className="text-sm text-muted-foreground">
          {status.state === "paused"
            ? (status.reason ?? "Waiting for a decision")
            : status.outcome?.status === "failed"
              ? `Failed: ${status.outcome.error.message}`
              : status.outcome?.status === "cancelled"
                ? "Stopped"
                : status.waiting ?? status.state}
        </p>
        {status.requests.length === 0 ? null : (
          <p className="text-sm">
            Waiting for an answer: <PageLink to="/requests" className="underline-offset-2 hover:underline">{status.requests.length} open</PageLink>
          </p>
        )}
      </header>
      <PhasePlan
        phases={phases}
        onRecompute={recompute}
        onStop={halt}
        canRecompute={() => status.state !== "running"}
        canStop={(target: PlanTarget) => status.state !== "finished" && (target.step !== undefined || target.phase === current)}
        explainRecompute={(target: PlanTarget) =>
          recomputeOf(inspection.data, target).from === undefined
            ? "Starts the run again from the top: the steps that did not change are taken from this run, and the first changed step and everything after it run again."
            : undefined
        }
        explainStop={(target: PlanTarget) =>
          target.step === undefined
            ? "Ends the whole run and interrupts the sessions it started."
            : "Stops this step: it ends as cancelled, its sessions are interrupted, and the rest of the run goes on."
        }
      />
      <RunSessions sessions={inspection.data.sessions} />
      {failure === null ? null : <p role="alert" className="text-sm text-destructive">{failure.message}</p>}
    </article>
  );
}
