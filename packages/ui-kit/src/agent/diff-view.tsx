/**
 * A diff of one or more files: from a unified patch, or from the old and new text of one file.
 * Highlighting and long-file virtualisation come from the diff renderer.
 */

import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";

import { cn } from "../lib/cn.ts";

export type DiffLayout = "unified" | "split";

type DiffCommon = {
  layout?: DiffLayout | undefined;
  /** Wrap long lines instead of scrolling them. */
  wrap?: boolean | undefined;
  className?: string | undefined;
};

export type DiffViewProps = DiffCommon &
  (
    | { patch: string; before?: undefined; after?: undefined }
    | {
        patch?: undefined;
        /** The file before the change. */
        before: { name: string; contents: string };
        /** The file after the change. */
        after: { name: string; contents: string };
      }
  );

export function DiffView(props: DiffViewProps) {
  const options = {
    diffStyle: props.layout ?? "unified",
    overflow: props.wrap === true ? ("wrap" as const) : ("scroll" as const),
    themeType: "system" as const,
  };
  const className = cn("block min-w-0 overflow-hidden rounded-lg border text-xs", props.className);
  if (props.patch !== undefined) {
    return <PatchDiff patch={props.patch} options={options} className={className} />;
  }
  return <MultiFileDiff oldFile={props.before} newFile={props.after} options={options} className={className} />;
}
