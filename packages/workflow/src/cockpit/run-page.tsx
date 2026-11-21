/** One run: where it stands, and its plan of phases and steps with the controls to run it again or stop it. */

import { EntityLink, PageLink, useAction, useCall, type PageProps } from "@niwa-labs/cockpit-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { PhasePlan, StateRing, formatDuration, type PhasePlanStep, type PlanTarget } from "@niwa-labs/ui-kit";

import { cancelAction, inspectAction, resumeAction, type Step } from "./actions.ts";
import { planOf, stepDuration, stepState } from "./plan.ts";
import { ringOf } from "./runs.tsx";

function toStep(step: Step): PhasePlanStep {
  const took = stepDuration(step);
  return {
    id: step.id,
    title: step.label === "" ? step.action : step.label,
    state: stepState(step),
    ...(took === undefined ? {} : { meta: formatDuration(took) }),
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

export function RunPage({ params }: PageProps<"/runs/$runId">) {
  const run = params.runId;
  const queryClient = useQueryClient();
  const inspection = useCall(inspectAction, { run }, { refreshOn: { types: ["workflow.*", "niwa.step.*", "niwa.invocation.state"] } });
  const resume = useAction(resumeAction);
  const cancel = useAction(cancelAction);

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
  const first = phases[0]?.id;
  const current = phases.find((phase) => phase.state === "running" || phase.state === "waiting")?.id;
  const reread = (): void => void queryClient.invalidateQueries({ queryKey: ["niwa", "call"] });

  // The host runs and stops a whole run: a plan row stands for the run, so the controls sit on the rows that say so.
  const recompute = (): void => resume.mutate({ run }, { onSettled: reread });
  const stop = (): void => cancel.mutate({ run }, { onSettled: reread });
  const failure = resume.error ?? cancel.error;

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
        onStop={stop}
        canRecompute={(target: PlanTarget) => target.step === undefined && target.phase === first && status.state !== "running"}
        canStop={(target: PlanTarget) => target.step === undefined && target.phase === current && status.state !== "finished"}
        explainRecompute={() => "Runs the whole workflow again from the top. Calls that finished are answered from the journal; the ones that changed run again."}
        explainStop={() => "Ends the whole run and interrupts the sessions it started."}
      />
      {failure === null ? null : <p role="alert" className="text-sm text-destructive">{failure.message}</p>}
    </article>
  );
}
