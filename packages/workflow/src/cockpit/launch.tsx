import {
  SchemaFields,
  readFields,
  type FormSchema,
  PageLink,
  useAction,
  useCall,
  useNavigate,
  useViewer,
  type PageProps,
} from "@niwa-labs/cockpit-sdk";
import { useState, type FormEvent } from "react";
import { inspectAction as catalogueRunArgs } from "./actions.ts";
import { catalogue, catalogueEvents } from "./catalogue-actions.ts";

export function LaunchPage({ search }: PageProps) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [id, setId] = useState(search.id ?? "");
  const [error, setError] = useState("");
  const list = useCall(catalogue.list, {}, { enabled: viewer.can(catalogue.list), refreshOn: catalogueEvents });
  const entity = useCall(
    catalogue.get,
    { id },
    { enabled: !!id && viewer.can(catalogue.get), refreshOn: catalogueEvents },
  );
  const start = useAction(catalogue.start);
  const latest = entity.data?.versions.filter((v) => !v.candidate).at(-1);
  const fields = latest?.input as FormSchema | undefined;
  const original = useCall(
    catalogueRunArgs,
    { run: search.run ?? "" },
    { enabled: !!search.run && viewer.can(catalogueRunArgs) },
  );
  const previous = original.data?.origin;
  const args = previous?.args;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (start.isPending) return;
    const form = new FormData(event.currentTarget);
    const label = String(form.get("label") ?? "").trim();
    const directory = String(form.get("directory") ?? "").trim();
    try {
      let input: unknown;
      if (fields) {
        input = readFields(fields, form);
      } else {
        const json = String(form.get("json") ?? "").trim();
        if (json) input = JSON.parse(json);
      }
      setError("");
      start.mutate(
        {
          ...(id ? { id } : { file: String(form.get("file") ?? "").trim() }),
          ...(input === undefined ? {} : { args: input }),
          ...(label ? { label } : {}),
          ...(directory ? { directory } : {}),
        },
        { onSuccess: (result) => navigate("/runs/" + encodeURIComponent(result.run)) },
      );
    } catch {
      setError("Проверьте JSON в аргументах запуска.");
    }
  };
  return (
    <article className="desk-page">
      <PageLink to="/workflows">← Сценарии</PageLink>
      <h1>Запустить workflow</h1>
      {!viewer.can(catalogue.start) ? (
        <p>Нет доступа к запуску.</p>
      ) : (
        <form className="desk-form" onSubmit={submit} key={previous?.requestedAt ?? ""}>
          <label>
            Сценарий
            <select
              value={id}
              onChange={(event) => {
                setId(event.target.value);
                setError("");
                start.reset();
              }}
            >
              <option value="">Локальный файл TypeScript</option>
              {list.data?.items.map((item) => (
                <option key={item.id} value={item.id} disabled={item.broken}>
                  {item.description} · {item.id}
                </option>
              ))}
            </select>
          </label>
          {list.error && <p role="alert">{list.error.message}</p>}
          {!id && (
            <label>
              Файл на хосте
              <input name="file" placeholder="/путь/workflow.ts" defaultValue={previous?.file ?? ""} required />
            </label>
          )}
          <label>
            Название запуска
            <input name="label" defaultValue={previous?.label ?? ""} placeholder="По имени сценария" />
          </label>
          <label>
            Проект
            <input
              name="directory"
              defaultValue={search.project ?? previous?.directory ?? ""}
              placeholder="/путь/к/проекту"
            />
          </label>
          <fieldset key={id + (latest?.version ?? "")}>
            {fields ? (
              <SchemaFields schema={fields} initial={args} />
            ) : (
              (!id || latest?.input !== undefined || args !== undefined) && (
                <label>
                  Аргументы JSON
                  <textarea
                    name="json"
                    rows={4}
                    defaultValue={args === undefined ? "" : JSON.stringify(args, null, 2)}
                    placeholder="{}"
                  />
                </label>
              )
            )}
          </fieldset>
          {entity.error && <p role="alert">{entity.error.message}</p>}
          {latest?.broken && <p role="alert">{latest.broken}</p>}
          {!!latest?.on?.length && <p>Этот сценарий запускается по подписке.</p>}
          {(error || start.error) && <p role="alert">{error || start.error?.message}</p>}
          <button
            className="desk-primary"
            disabled={
              start.isPending ||
              (!!search.run && original.isLoading) ||
              (!!id && (!latest || !!latest.broken || !!latest.on?.length))
            }
          >
            ▶ Запустить
          </button>
        </form>
      )}
    </article>
  );
}
