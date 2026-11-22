import { DataValue } from "@niwa-labs/ui-kit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useHost, useViewer } from "./runtime.tsx";
import { SchemaFields, readFields, type FormSchema } from "./schema-form.tsx";

/** A plugin chooses the commands that belong on its page. Presets are initial form values. */
export interface PageCommand {
  action: string;
  label: string;
  preset?: Record<string, unknown> | undefined;
}

function CommandForm({ command }: { command: PageCommand }) {
  const host = useHost();
  const client = useQueryClient();
  const [error, setError] = useState("");
  const schema = useQuery({
    queryKey: ["niwa", "schema", command.action],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const info = await host.info({ action: command.action, signal });
      const action = info.action as { input?: FormSchema; name?: string; destructive?: boolean } | undefined;
      if (action?.name !== command.action || !action.input) throw new Error("Хост не предоставил схему действия.");
      return { input: action.input, destructive: action.destructive };
    },
  });
  const call = useMutation({
    mutationFn: (input: unknown) => host.call(command.action, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["niwa", "call"] }),
  });
  if (!schema.data) return <p role="status">{schema.error?.message ?? "Загружаю поля…"}</p>;
  const { input, destructive } = schema.data;
  return (
    <form
      className="desk-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (call.isPending) return;
        try {
          const value = readFields(input, new FormData(event.currentTarget)) ?? {};
          if (destructive && !window.confirm(command.label + "?")) return;
          setError("");
          call.mutate(value);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}
    >
      <SchemaFields schema={input} initial={command.preset} />
      <button className="desk-primary" disabled={call.isPending}>
        {command.label}
      </button>
      {(error || call.error) && <p role="alert">{error || call.error?.message}</p>}
      {call.isSuccess && (
        <details open>
          <summary>Результат</summary>
          <DataValue value={call.data}/>
        </details>
      )}
    </form>
  );
}

export function PageCommands({ commands }: { commands: readonly PageCommand[] }) {
  const viewer = useViewer();
  const [selected, setSelected] = useState("");
  const visible = commands.filter((command) => viewer.can(command.action));
  const command = visible.find((item) => item.action === selected);
  if (!visible.length) return null;
  return (
    <section aria-label="Действия" className="desk-commands">
      <div className="desk-tools">
        {visible.map((c) => (
          <button
            key={c.action}
            aria-expanded={command?.action === c.action}
            onClick={() => setSelected(command?.action === c.action ? "" : c.action)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {command && <CommandForm key={command.action} command={command} />}
    </section>
  );
}
