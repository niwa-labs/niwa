import { PageLink, useAction, useCall, useViewer } from "@niwa-labs/cockpit-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { cancelAction, inspectAction, type RunEntry } from "./actions.ts";
import { catalogue, catalogueEvents, workflowPath } from "./catalogue-actions.ts";

type Props = { run: string; state: RunEntry["state"]; workflow?: string | undefined; compact?: boolean };
export function RunCommands(props: Props) {
  const [expanded, setExpanded] = useState(false);
  if (props.compact && !expanded)
    return (
      <button className="desk-disclose" onClick={() => setExpanded(true)}>
        Управление запуском
      </button>
    );
  return <Commands {...props} />;
}
function Commands({ run, state, workflow }: Props) {
  const viewer = useViewer();
  const client = useQueryClient();
  const inspect = useCall(inspectAction, { run }, { enabled: viewer.can(inspectAction), refreshOn: catalogueEvents });
  const status = inspect.data?.status;
  const manual = status?.manualPause;
  const pause = useAction(catalogue.pause);
  const resume = useAction(catalogue.resume);
  const onward = useAction(catalogue.continue);
  const cancel = useAction(cancelAction);
  const revise = useAction(catalogue.revise);
  const pending = pause.isPending || resume.isPending || onward.isPending || cancel.isPending || revise.isPending;
  const error = pause.error ?? resume.error ?? onward.error ?? cancel.error ?? revise.error ?? inspect.error;
  const refresh = () => void client.invalidateQueries({ queryKey: ["niwa", "call"] });
  const finished = (status?.state ?? state) === "finished";
  const stopped = status?.state === "paused";
  const originId = inspect.data?.origin.workflow ?? workflow;
  const launch = new URLSearchParams({ run, ...(originId ? { id: originId } : {}) });
  return (
    <div className="desk-controls">
      <div className="desk-tools">
        {originId && <PageLink to={workflowPath(originId)}>Сценарий</PageLink>}
        {finished && viewer.can(catalogue.start) && (
          <PageLink to={"/workflows/launch?" + launch}>↻ Запустить снова</PageLink>
        )}
        {!finished && status && !manual && !stopped && viewer.can(catalogue.pause) && (
          <button disabled={pending} onClick={() => pause.mutate({ run }, { onSettled: refresh })}>
            Пауза
          </button>
        )}
        {manual && viewer.can(catalogue.continue) && (
          <button disabled={pending} onClick={() => onward.mutate({ run, pause: manual.id }, { onSettled: refresh })}>
            {manual.state === "requested" ? "Снять запрос паузы" : "Продолжить"}
          </button>
        )}
        {stopped &&
          !manual &&
          viewer.can(catalogue.resume) &&
          (["retry", "skip"] as const)
            .filter((c) => status.choices?.includes(c))
            .map((choice) => (
              <button
                key={choice}
                disabled={pending}
                onClick={() => resume.mutate({ run, choice }, { onSettled: refresh })}
              >
                {choice === "retry" ? "Повторить шаг" : "Пропустить шаг"}
              </button>
            ))}
        {!finished && viewer.can(cancelAction) && (
          <button
            disabled={pending}
            onClick={() => {
              if (window.confirm("Остановить запуск " + run + "?")) cancel.mutate({ run }, { onSettled: refresh });
            }}
          >
            Остановить запуск
          </button>
        )}
      </div>
      {(stopped || status?.outcome?.status === "failed") && viewer.can(catalogue.revise) && (
        <details>
          <summary>Пересмотреть сценарий</summary>
          <form
            className="desk-form"
            onSubmit={(e) => {
              e.preventDefault();
              const file = String(new FormData(e.currentTarget).get("file")).trim();
              revise.mutate({ run, file }, { onSettled: refresh });
            }}
          >
            <label>
              Исправленный файл
              <input name="file" required defaultValue={inspect.data?.origin.file} />
            </label>
            <button disabled={pending}>Применить ревизию</button>
          </form>
        </details>
      )}
      {revise.data && <pre>{JSON.stringify(revise.data.revision, null, 2)}</pre>}
      {error && <p role="alert">{error.message}</p>}
    </div>
  );
}
