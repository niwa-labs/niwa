# @niwa-labs/ui-kit

The shared React components of the cockpit, on Tailwind 4 and Base UI.

- `src/theme.css`: design tokens as CSS variables (light and dark), the work-state colours and
  the `shimmer` utility. The application imports Tailwind, then this file.
- Primitives: button, badge, tooltip, tabs, collapsible, spinner, and the `Trace` and `Message`
  parts that agent steps and turns are built from.
- Agent blocks: `IdChip`, `StateRing`, `ToolCall`, `Markdown` (streaming, highlighted code),
  `DiffView`, `Transcript` (virtualised, follows the bottom while the reader is there).
- `PhasePlan`: phases and steps of a run with small recompute and stop controls. They ask in
  place: the first press explains what will be affected, a second press or a held press
  confirms, and a confirmed action can be undone for a few seconds before it is sent.
  `guardReducer` is the pure state machine behind them.

React and React DOM are peer dependencies: the cockpit and the modules it loads share one copy.
