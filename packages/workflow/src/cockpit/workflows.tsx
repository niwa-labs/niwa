import { runSummary } from "./run-summary.ts";
import { SchemaView, DataValue, CopyValue, FileRef } from "@niwa-labs/ui-kit";
import { PageHeading, PageSection } from "@niwa-labs/ui-kit";
import { PageLink, useAction, useCall, useViewer, type PageProps } from "@niwa-labs/cockpit-sdk";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { catalogue, catalogueEvents, workflowPath } from "./catalogue-actions.ts";
import { Statistics } from "./statistics.tsx";
import { runsAction } from "./actions.ts";

function Contract({ title, value }: { title: string; value: unknown }) {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return null;
  return (
    <details className="nw-contract" open={title === "Вход"}>
      <summary>{title}</summary>
      {title === "Вход" || title === "Выход" ? <SchemaView schema={value} /> : <DataValue value={value} />}
    </details>
  );
}

export function WorkflowCatalogue({ search }: PageProps<"/workflows">) {
  const viewer = useViewer();
  const client = useQueryClient();
  const list = useCall(catalogue.list, {}, { enabled: viewer.can(catalogue.list), refreshOn: catalogueEvents });
  const check = useAction(catalogue.check);
  const register = useAction(catalogue.register);
  const [query, setQuery] = useState("");
  const [file, setFile] = useState("");
  const [id, setId] = useState("");
  const busy = check.isPending || register.isPending;
  const tabs = [
    { key: "catalogue", label: "Каталог", allowed: viewer.can(catalogue.list) },
    { key: "statistics", label: "Статистика", allowed: viewer.can(catalogue.stats) },
    { key: "register", label: "Регистрация", allowed: viewer.can(catalogue.check) || viewer.can(catalogue.register) },
  ].filter((tab) => tab.allowed);
  const current = tabs.find((tab) => tab.key === search.view)?.key ?? tabs[0]?.key;
  const needle = query.trim().toLowerCase();
  const matches = list.data?.items.filter((w) =>
    [w.description, w.id, w.builtin?.name, ...(w.phases ?? []).map((p) => p.title)]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
  return (
    <article className="desk-page" data-slot="workflows">
      <PageHeading title="Сценарии">
        {viewer.can(catalogue.start) && (
          <PageLink to="/workflows/launch" className="desk-primary">
            Запустить сценарий
          </PageLink>
        )}
      </PageHeading>
      <nav className="nw-tabs" aria-label="Разделы сценариев">
        {tabs.map((tab) => (
          <PageLink
            key={tab.key}
            to={tab.key === "catalogue" ? "/workflows" : "/workflows?view=" + tab.key}
            aria-current={current === tab.key ? "page" : undefined}
          >
            {tab.label}
          </PageLink>
        ))}
      </nav>
      {!current && <p>Нет доступных разделов сценариев.</p>}
      {current === "catalogue" && (
        <PageSection title={<>Зарегистрированные сценарии {list.data && <small>{list.data.items.length}</small>}</>}>
          <label className="nw-search">
            <span>Найти сценарий</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Название, фаза или ID"
            />
          </label>
          {!viewer.can(catalogue.list) ? (
            <p>Каталог недоступен для этого пользователя.</p>
          ) : list.error ? (
            <p role="alert">{list.error.message}</p>
          ) : !list.data ? (
            <p>Загружаю сценарии…</p>
          ) : !list.data.items.length ? (
            <p>Сценариев ещё нет. Зарегистрируйте файл сценария.</p>
          ) : (
            <div className="desk-catalogue">
              {matches?.map((w) => (
                <article key={w.id} className="desk-card">
                  <PageLink to={workflowPath(w.id)}>{w.description}</PageLink>
                  {w.candidate && (
                    <span className="nw-tag" data-tone="amber">
                      Кандидат
                    </span>
                  )}{" "}
                  <CopyValue value={w.id} />
                  <small>
                    Версия {w.version.slice(0, 8)} · версий {w.versions} · установок {w.installations.length}
                  </small>
                  {!!w.phases?.length && <p>{w.phases.map((p) => p.title).join(" → ")}</p>}
                  {w.broken && <p role="alert">Сценарий требует исправления</p>}
                </article>
              ))}
              {!matches?.length && <p>Совпадений нет.</p>}
            </div>
          )}
        </PageSection>
      )}
      {current === "statistics" && <Statistics />}
      {current === "register" && (
        <PageSection title="Файл сценария">
          <form
            className="desk-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
              if (submitter?.value === "register")
                register.mutate(
                  { file: file.trim(), ...(id ? { id } : {}) },
                  { onSuccess: () => void client.invalidateQueries({ queryKey: ["niwa", "call"] }) },
                );
              else if (viewer.can(catalogue.check)) check.mutate({ file: file.trim() });
            }}
          >
            <label>
              Файл сценария на хосте
              <input
                value={file}
                onChange={(e) => {
                  setFile(e.target.value);
                  check.reset();
                  register.reset();
                }}
                required
                placeholder="/путь/workflow.ts"
              />
            </label>
            {viewer.can(catalogue.register) && (
              <label>
                Зарегистрировать как
                <select
                  value={id}
                  onChange={(e) => {
                    setId(e.target.value);
                    register.reset();
                  }}
                >
                  <option value="">Новый сценарий</option>
                  {list.data?.items
                    .filter((w) => !w.builtin)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.description} · {w.id}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <div className="desk-tools">
              {viewer.can(catalogue.check) && (
                <button value="check" disabled={busy}>
                  Проверить
                </button>
              )}
              {viewer.can(catalogue.register) && (
                <button value="register" disabled={busy}>
                  Зарегистрировать
                </button>
              )}
            </div>
          </form>
          {check.data && (
            <div role="status">
              <strong>{check.data.ok ? "Проверка пройдена" : "Ошибка проверки"}</strong> ·{" "}
              <FileRef path={check.data.file} />
              {[...check.data.errors, ...(check.data.warnings ?? [])].map((e, i) => (
                <p key={i}>
                  <FileRef path={e.file} /> · строка {e.line}, столбец {e.column} · {e.message}
                </p>
              ))}
              <p>{check.data.description}</p>
              <Contract title="Вход" value={check.data.input} />
              <Contract title="Выход" value={check.data.output} />
              <Contract title="События" value={check.data.emits} />
            </div>
          )}
          {register.data && (
            <p role="status">
              {register.data.added ? "Зарегистрирована версия" : "Уже зарегистрирована"}{" "}
              {register.data.version.slice(0, 8)} ·{" "}
              <PageLink to={workflowPath(register.data.id)}>{register.data.description}</PageLink>
              {register.data.rechecked.map((r) => (
                <span key={r.id}>
                  {" "}
                  · {r.id} {r.ok ? "✓" : "сломан"}
                </span>
              ))}
            </p>
          )}
          {(check.error || register.error) && <p role="alert">{(check.error ?? register.error)?.message}</p>}
        </PageSection>
      )}
    </article>
  );
}

function Installation({ id, builtin }: { id: string; builtin: boolean }) {
  const viewer = useViewer();
  const client = useQueryClient();
  const got = useCall(
    catalogue.installation,
    { id },
    { enabled: viewer.can(catalogue.installation), refreshOn: catalogueEvents },
  );
  const remove = useAction(catalogue.uninstall);
  return (
    <li>
      <b>{got.data?.description ?? id}</b> <CopyValue value={id} />
      {got.data && <Contract title="Условия запуска" value={got.data.on} />}
      {got.error && <p role="alert">{got.error.message}</p>}
      {!builtin && viewer.can(catalogue.uninstall) && (
        <button
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm("Снять установку " + id + "?"))
              remove.mutate({ id }, { onSuccess: () => void client.invalidateQueries({ queryKey: ["niwa", "call"] }) });
          }}
        >
          Снять установку
        </button>
      )}
      {remove.error && <p role="alert">{remove.error.message}</p>}
    </li>
  );
}

export function WorkflowDetails({ params }: PageProps<"/workflows/$workflowId">) {
  const id = params.workflowId;
  const viewer = useViewer();
  const got = useCall(catalogue.get, { id }, { enabled: viewer.can(catalogue.get), refreshOn: catalogueEvents });
  const history = useCall(runsAction, {}, { enabled: viewer.can(runsAction), refreshOn: catalogueEvents });
  const install = useAction(catalogue.install);
  const client = useQueryClient();
  const entity = got.data;
  if (!entity)
    return (
      <article className="desk-page">
        <PageLink className="nw-parent" to="/workflows">
          ← Сценарии
        </PageLink>
        <p>{!viewer.can(catalogue.get) ? "Нет доступа к сценарию." : (got.error?.message ?? "Загружаю сценарий…")}</p>
      </article>
    );
  const latest = entity.versions.filter((v) => !v.candidate && !v.superseded).at(-1);
  const runs = history.data?.entries.filter((r) => r.workflow === id);
  return (
    <article className="desk-page" data-slot="workflow-detail">
      <PageLink className="nw-parent" to="/workflows">
        ← Сценарии
      </PageLink>
      <header className="desk-heading">
        <div>
          <h1>
            {(latest ?? entity.versions.at(-1))?.file
              .split(/[\\/]/)
              .at(-1)
              ?.replace(/\.[^.]+$/, "") ?? entity.description}
          </h1>
          <p className="nw-purpose">{entity.description}</p>
          <CopyValue value={id} />
        </div>
        {viewer.can(catalogue.start) && latest && !latest.broken && !latest.on?.length && (
          <PageLink to={"/workflows/launch?id=" + encodeURIComponent(id)} className="desk-primary">
            ▶ Запустить
          </PageLink>
        )}
      </header>
      <section className="desk-section">
        <h2>
          Версии <small>{entity.versions.length}</small>
        </h2>
        {entity.versions.toReversed().map((v) => (
          <details
            className="desk-version"
            key={v.version}
            open={v.version === (latest ?? entity.versions.at(-1))?.version}
          >
            <summary>
              <span className="nw-tag" data-tone="blue">
                {v.version.slice(0, 8)}
              </span>{" "}
              {v.superseded
                ? "Заменена"
                : v.candidate
                  ? "Кандидат"
                  : v.version === latest?.version
                    ? "Текущая версия"
                    : v.description}
            </summary>
            <div className="nw-file-row">
              <FileRef path={v.file} />
              <CopyValue value={v.version} label="Хеш версии" />
            </div>
            {v.candidate && (
              <p className="nw-candidate">До принятия эта версия доступна только для проверочного запуска комплекта.</p>
            )}
            {v.broken && <p role="alert">{v.broken}</p>}
            {!!v.phases?.length && (
              <ol className="desk-phases">
                {v.phases.map((p) => (
                  <li key={p.title}>
                    <b>{p.title}</b>
                    {p.detail && <small>{p.detail}</small>}
                  </li>
                ))}
              </ol>
            )}
            <Contract title="Вход" value={v.input} />
            <Contract title="Выход" value={v.output} />
            <Contract title="События" value={v.emits} />
            <Contract title="Разрешения" value={v.uses} />
            <Contract title="Вызывает" value={v.calls} />
            <Contract title="Триггеры" value={v.on} />
          </details>
        ))}
      </section>
      <section className="desk-section">
        <h2>
          Установки <small>{entity.installations.length}</small>
        </h2>
        {!entity.installations.length && (
          <p>{latest?.on?.length ? "Подписок пока нет." : "У этой версии нет подписок."}</p>
        )}
        <ul>
          {entity.installations.map((sub) => (
            <Installation key={sub} id={sub} builtin={!!entity.builtin} />
          ))}
        </ul>
        {viewer.can(catalogue.install) && !!latest?.on?.length && !latest.broken && (
          <form
            className="desk-form"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              install.mutate(
                { id, description: String(data.get("description")).trim() },
                { onSuccess: () => void client.invalidateQueries({ queryKey: ["niwa", "call"] }) },
              );
            }}
          >
            <label>
              Описание установки
              <input name="description" minLength={3} maxLength={60} required />
            </label>
            <button disabled={install.isPending}>Установить последнюю версию</button>
            {install.error && <p role="alert">{install.error.message}</p>}
          </form>
        )}
      </section>
      {viewer.can(runsAction) && (
        <section className="desk-section">
          <h2>Запуски</h2>
          {history.error ? (
            <p role="alert">{history.error.message}</p>
          ) : !runs ? (
            <p>Загружаю…</p>
          ) : runs.length ? (
            runs.map((r) => (
              <p key={r.run}>
                <PageLink to={"/runs/" + r.run}>
                  {r.name} · {r.run}
                </PageLink>{" "}
                · {runSummary(r)}
              </p>
            ))
          ) : (
            <p>Запусков по этому сценарию ещё не было.</p>
          )}
        </section>
      )}
      {viewer.can(catalogue.stats) && <Statistics key={id} id={id} versions={entity.versions.map((v) => v.version)} />}
    </article>
  );
}
