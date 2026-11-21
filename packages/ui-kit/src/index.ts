// The cockpit's shared components. Styles come from Tailwind classes over the tokens of
// `src/theme.css`, which the application imports into its stylesheet.

export { cn } from "./lib/cn.ts";

export { Badge, badgeVariants, type BadgeProps } from "./ui/badge.tsx";
export { Button, buttonVariants, type ButtonProps } from "./ui/button.tsx";
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
export {
  MessageAvatar,
  Message,
  MessageBubble,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "./ui/message.tsx";
export { Spinner } from "./ui/spinner.tsx";
export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants } from "./ui/tabs.tsx";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.tsx";
export {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  type TraceStatus,
} from "./ui/trace.tsx";

export { isSettled, StateRing, WORK_STATE_LABEL, type StateRingProps, type WorkState } from "./agent/state.tsx";
export { IdChip, idPrefix, isPlainClick, shortId, type IdChipProps } from "./agent/id-chip.tsx";
export { formatAgo, formatDuration, formatPayload } from "./agent/payload.ts";
export { ToolCall, type ToolCallProps, type ToolCallState } from "./agent/tool-call.tsx";
export { Markdown, type MarkdownProps } from "./agent/markdown.tsx";
export { DiffView, type DiffLayout, type DiffViewProps } from "./agent/diff-view.tsx";
export { Transcript, type TranscriptProps } from "./agent/transcript.tsx";
export {
  DEFAULT_GUARD_TIMING,
  firesOnUnmount,
  guardReducer,
  holdProgress,
  IDLE,
  nextDeadline,
  type GuardEvent,
  type GuardState,
  type GuardTiming,
} from "./agent/guard.ts";
export {
  GuardButton,
  GuardNotice,
  useGuardedAction,
  type GuardButtonProps,
  type GuardedAction,
  type GuardedActionOptions,
  type GuardNoticeProps,
} from "./agent/guarded-action.tsx";
export {
  describeRecompute,
  describeStop,
  recomputeImpact,
  stopImpact,
  targetTitle,
  type PlanPhase,
  type PlanStep,
  type PlanTarget,
  type RecomputeImpact,
  type StopImpact,
} from "./agent/plan-impact.ts";
export { PhasePlan, type PhasePlanPhase, type PhasePlanProps, type PhasePlanStep } from "./agent/phase-plan.tsx";
