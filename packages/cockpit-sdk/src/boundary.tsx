/**
 * The boundary around everything a module renders. A component that throws is replaced by a
 * small notice in its own place and reported as a fault; the frame and the other modules keep
 * working. The notice offers to render the part again.
 */

import { cn } from "@niwa-labs/ui-kit";
import { Component, type ContextType, type ReactNode } from "react";

import { faultMessage, type PluginFault } from "./contract.ts";
import { CockpitContext } from "./runtime.tsx";

export type PluginBoundaryProps = {
  plugin: string;
  /** The slot, page or entity kind being rendered. */
  place: string;
  /** Rendering again with another key clears a failure, e.g. the address of the page shown. */
  resetKey?: string | undefined;
  /** What to show in place of the failed part; a compact notice by default. */
  fallback?: ((fault: PluginFault, retry: () => void) => ReactNode) | undefined;
  children?: ReactNode;
};

type Shown = { plugin: string; place: string; resetKey: string | undefined };

type BoundaryState = ({ failed: false } | { failed: true; error: unknown }) & { shown: Shown };

export function FaultNotice({ fault, retry, className }: { fault: PluginFault; retry?: (() => void) | undefined; className?: string }) {
  return (
    <div
      role="alert"
      data-slot="plugin-fault"
      data-plugin={fault.plugin}
      className={cn("flex min-w-0 items-center gap-2 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground", className)}
    >
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{fault.plugin}</span> failed here: {fault.message}
      </span>
      {retry === undefined ? null : (
        <button type="button" className="ml-auto shrink-0 font-medium underline-offset-2 hover:underline" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export class PluginBoundary extends Component<PluginBoundaryProps, BoundaryState> {
  static override contextType = CockpitContext;
  declare context: ContextType<typeof CockpitContext>;
  override state: BoundaryState = {
    failed: false,
    shown: { plugin: this.props.plugin, place: this.props.place, resetKey: this.props.resetKey },
  };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failed: true, error };
  }

  // A failure belongs to what was shown: another module, place or page starts clean, without
  // showing the old failure once under the new place.
  static getDerivedStateFromProps(props: PluginBoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    const { shown } = state;
    if (shown.plugin === props.plugin && shown.place === props.place && shown.resetKey === props.resetKey) return null;
    return { failed: false, shown: { plugin: props.plugin, place: props.place, resetKey: props.resetKey } };
  }

  private fault(error: unknown): PluginFault {
    return { plugin: this.props.plugin, phase: "render", place: this.props.place, message: faultMessage(error), error };
  }

  override componentDidCatch(error: unknown): void {
    const fault = this.fault(error);
    if (this.context === null) console.error(`niwa cockpit: ${fault.plugin} failed in ${fault.place}`, error);
    else this.context.reportFault(fault);
  }

  private readonly retry = (): void => this.setState({ failed: false });

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const fault = this.fault(this.state.error);
    return this.props.fallback === undefined ? <FaultNotice fault={fault} retry={this.retry} /> : this.props.fallback(fault, this.retry);
  }
}
