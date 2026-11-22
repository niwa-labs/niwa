/** Journal pause reasons embed the full step key, which can itself contain colons. */
export function stepPause(reason?: string) {
  const match = /^step (.+): (unknown|failed)$/.exec(reason ?? "");
  if (!match) return undefined;
  const key = match[1]!;
  const unknown = match[2] === "unknown";
  return {
    key,
    label: key.replace(/^label:/, ""),
    unknown,
    title: unknown ? "Результат шага неизвестен" : "Шаг завершился с ошибкой",
  };
}

export function StepPauseLabel({ pause, label }: { pause: NonNullable<ReturnType<typeof stepPause>>; label?: string }) {
  return (
    <span className="inline-flex max-w-full items-baseline gap-1.5">
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 20 20" fill="none"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        className="shrink-0 self-center text-amber-400">
        {pause.unknown ? <><circle cx="10" cy="10" r="8" /><path d="M7.8 7.6a2.3 2.3 0 1 1 3.8 1.8c-1 .6-1.6 1-1.6 2" /></>
          : <><path d="m8.6 3.4-7 12.2a1.6 1.6 0 0 0 1.4 2.3h14a1.6 1.6 0 0 0 1.4-2.3l-7-12.2a1.6 1.6 0 0 0-2.8 0Z" /><path d="M10 7v4" /></>}
        <circle cx="10" cy="14" r=".8" fill="currentColor" stroke="none" />
      </svg>
      <span className="min-w-0 wrap-anywhere">{pause.title} · {label || pause.label}</span>
    </span>
  );
}
