/**
 * A diff of one or more files: from a unified patch, or from the old and new text of one file.
 * Highlighting and long-file virtualisation come from the diff renderer.
 */

import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

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
  // The renderer takes one file at a time, so a patch is split into the files it holds.
  const patch = props.patch;
  const files = useMemo(() => (patch === undefined ? [] : parsePatchFiles(patch).flatMap((parsed) => parsed.files)), [patch]);
  const options = {
    diffStyle: props.layout ?? "unified",
    overflow: props.wrap === true ? ("wrap" as const) : ("scroll" as const),
    themeType: "system" as const,
    preferredHighlighter: "highlights" as const,
  };
  const fileClassName = "block min-w-0 overflow-hidden rounded-lg border text-xs";
  if (props.patch !== undefined) {
    if (files.length === 0) return null;
    return (
      <div data-slot="diff-view" className={cn("flex min-w-0 flex-col gap-3", props.className)}>
        {files.map((file, index) => (
          <FileDiff key={`${String(index)}:${file.name}`} fileDiff={file} options={options} className={fileClassName} />
        ))}
      </div>
    );
  }
  return (
    <MultiFileDiff
      oldFile={props.before}
      newFile={props.after}
      options={options}
      className={cn(fileClassName, props.className)}
    />
  );
}
