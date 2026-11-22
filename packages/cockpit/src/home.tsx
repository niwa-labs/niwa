import { PageHeading } from "@niwa-labs/ui-kit";
import {
  Slot,
  SlotPart,
  useSlot,
  useNavigate,
  useStreamStatus,
  type HomeTileProps,
  type RegisteredContribution,
} from "@niwa-labs/cockpit-sdk";
import { useState, useCallback } from "react";

type Part = RegisteredContribution<HomeTileProps>;
function MainTile({
  part,
  project,
  report,
}: {
  part: Part;
  project: string;
  report: (key: string, dirs: readonly string[]) => void;
}) {
  const reportProjects = useCallback(
    (dirs: readonly string[]) => report(part.plugin + "/" + part.key, dirs),
    [report, part],
  );
  return <SlotPart place="home.main" contribution={part} props={{ project, reportProjects }} />;
}

export function Home({ project = "" }: { project?: string }) {
  const main = useSlot("home.main");
  const side = useSlot("home.tile");
  const navigate = useNavigate();
  const [sources, setSources] = useState<Record<string, readonly string[]>>({});
  const { seq } = useStreamStatus();
  const report = useCallback((key: string, dirs: readonly string[]) => {
    setSources((old) => (old[key] === dirs ? old : { ...old, [key]: dirs }));
  }, []);
  const directories = [...new Set(Object.values(sources).flat())].sort();
  return (
    <div data-slot="home" className="desk-page">
      <PageHeading title="Ход запусков" meta={<a href="/journal">Журнал · {seq}</a>}>
        {(directories.length > 0 || project) && (
          <label>
            Проект{" "}
            <select
              aria-label="Проект"
              value={project}
              onChange={(e) =>
                navigate(e.target.value ? "/?project=" + encodeURIComponent(e.target.value) : "/", { replace: true })
              }
            >
              <option value="">Все проекты</option>
              {directories.map((dir) => (
                <option key={dir} value={dir}>
                  {dir.split("/").filter(Boolean).slice(-2).join("/") || dir}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeading>
      <Slot name="home.summary" props={{ project }} />
      <div className="desk-columns">
        <div>
          {main.map((part) => (
            <MainTile key={part.plugin + "/" + part.key} part={part} project={project} report={report} />
          ))}
        </div>
        {side.length > 0 && (
          <aside aria-label="Сводка">
            <Slot name="home.tile" props={{ project }} />
          </aside>
        )}
      </div>
      {!main.length && !side.length && <p>Подключённые плагины пока не добавили разделов на пульт.</p>}
    </div>
  );
}
