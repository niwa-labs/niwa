/**
 * The texts the scripts give their sessions, assembled from the mapping: the blocks of an upstream file that are
 * `prompt` verbatim from the snapshot, those that are `adapted` from our text they link to, in the order they have
 * upstream; `code` and `dropped` blocks are not in a prompt. A text is the files it is made of, one after the other.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Mapping } from "./schema.ts";
import type { Texts, UpstreamTexts } from "./sources.ts";

/** One text a downstream script imports. */
export interface AssembledText {
  /** The name of its file without `.json`: `bug-fix`. */
  readonly name: string;
  /** The heading of the text: `Bug fix`. */
  readonly title: string;
  /** The whole text. */
  readonly text: string;
}

/** The title of a text: its first heading, without the marks. */
export function titleOf(text: string, fallback: string): string {
  const heading = text.split("\n").find((line) => /^#{1,6}\s/.test(line));
  return heading === undefined ? fallback : heading.replace(/^#{1,6}\s+/, "").trim();
}

/** What a text is made of: the upstream files, in order. */
export interface TextSpec {
  readonly name: string;
  readonly title?: string;
  readonly files: readonly string[];
}

/** Assemble the text of one upstream file from its entries. */
function pieceOf(mapping: Mapping, upstream: UpstreamTexts, ours: Texts, file: string): string {
  const text = upstream.at(upstream.current, file);
  if (text === undefined) return "";
  const entries = mapping.entries.filter((one) => one.upstream.file === file).sort((a, b) => a.upstream.range[0] - b.upstream.range[0]);
  let out = "";
  for (const entry of entries) {
    if (!upstream.same(entry.upstream.commit, upstream.current)) {
      throw new Error(`${entry.id} is recorded at upstream commit ${entry.upstream.commit}, the snapshot is at ${upstream.current}: carry the entry to the snapshot before assembling`);
    }
    if (entry.kind === "prompt") out += text.slice(...entry.upstream.range);
    else if (entry.kind === "adapted") {
      for (const link of entry.ours) {
        const ourText = ours.at(link.commit, link.file);
        if (ourText === undefined) throw new Error(`${entry.id} links to ${link.file}, which does not exist at ${link.commit}`);
        out += ourText.slice(...link.range);
      }
    }
  }
  return out;
}

/** The texts of the mapping, in their configured order. Texts with no prompt blocks are omitted. */
export function assemble(mapping: Mapping, upstream: UpstreamTexts, ours: Texts): AssembledText[] {
  const made: AssembledText[] = [];
  for (const spec of upstream.textSpecs()) {
    const pieces = spec.files.map((file) => pieceOf(mapping, upstream, ours, file)).filter((piece) => piece !== "");
    if (pieces.length === 0) continue;
    const text = pieces.map((piece, index) => (index < pieces.length - 1 ? `${piece.replace(/\s+$/, "")}\n\n` : piece)).join("");
    made.push({ name: spec.name, title: spec.title ?? titleOf(text, spec.name), text });
  }
  return made;
}

/** The JSON file of a text, as the scripts import it. */
export const jsonOf = (one: AssembledText): string => `${JSON.stringify(one, null, 2)}\n`;

/** Write the texts as the JSON files the scripts import, and remove the ones that are no longer a text. */
export function writeTexts(texts: readonly AssembledText[], dir: string): void {
  mkdirSync(dir, { recursive: true });
  const names = new Set(texts.map((one) => `${one.name}.json`));
  for (const file of readdirSync(dir)) if (file.endsWith(".json") && !names.has(file)) rmSync(join(dir, file));
  for (const one of texts) writeFileSync(join(dir, `${one.name}.json`), jsonOf(one));
}
