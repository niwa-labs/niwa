/** The frame is the sandbox boundary; the small diamond is the running process. */
export function IsolationMark({ boxed, subject }: { boxed?: boolean; subject: string }) {
  const mode = boxed === true ? "boxed" : boxed === false ? "plain" : "unknown";
  const label = subject + " · " + ({
    boxed: "в песочнице",
    plain: "без песочницы",
    unknown: "нет данных об изоляции",
  } as const)[mode];
  return (
    <span tabIndex={0} role="img" aria-label={label}
        data-slot="isolation-mark" data-mode={mode}
        className="group/isolation relative inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {mode === "boxed" ? <>
            <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
            <path d="m12 8 4 4-4 4-4-4Z" fill="currentColor" stroke="none" />
          </> : mode === "plain" ? <>
            <path d="M12 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5M11 13l9-9m-6 0h6v6" />
          </> : <>
            <rect x="3.5" y="3.5" width="17" height="17" rx="4" strokeDasharray="2 3" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          </>}
        </svg>
      <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden w-max rounded bg-foreground px-2 py-1 text-xs font-normal text-background shadow-sm group-hover/isolation:block group-focus/isolation:block">{label}</span>
    </span>
  );
}
