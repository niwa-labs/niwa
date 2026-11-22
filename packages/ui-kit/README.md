# @niwa-labs/ui-kit

The shared React components of the cockpit, on Tailwind 4 and Base UI.

- `src/theme.css`: design tokens as CSS variables (light and dark), the work-state colours and
  the `shimmer` utility. The application imports Tailwind, then this file.
- `PageHeading` and `PageSection` lay out titles, context and action slots for
  the shell and independently loaded plugin pages. Both accept ordinary React
  children and HTML attributes.
- Primitives: button, badge, tooltip, tabs, collapsible, spinner, and the `Trace` and `Message`
  parts that agent steps and turns are built from.
- Agent blocks: `IdChip`, `StateRing`, `ToolCall`, `Markdown` (streaming, highlighted code),
  `DiffView`, `Transcript` (virtualised, follows the bottom while the reader is there).
- `PhaseSequence` shows the declared plan, including phases still ahead.
  `ExecutionTrack` takes the full ordered phase plan and the observed steps.
  Its detail view shows every declared phase up front. It follows the active
  phase until the reader selects another. Steps outside the plan can be
  passed as `looseSteps`. Phase details include overlapping branches, timestamps
  and duration bars on a shared scale. Pass timestamps in epoch
  milliseconds and pass a link as a step title to enable navigation.
- `ActivityLabel` and `MiniPhaseTrack` can be used on lists and plugin pages.
  The kit owns motion and honours reduced motion. The plugin maps its own
  events to working, starting, human, timer or paused activity and clears
  activity on settled work. The kit never connects to a host or routes links.
- `PhasePlan`: phases and steps of a run with small recompute and stop controls. They ask in
  place: the first press explains what will be affected, a second press or a held press
  confirms, and a confirmed action can be undone for a few seconds before it is sent.
  `guardReducer` is the pure state machine behind them.

React and React DOM are peer dependencies: the cockpit and the modules it loads share one copy.
