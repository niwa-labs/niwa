/**
 * The file index: each path a window's tool calls name is given a short reference the first time
 * it is seen, and every later mention of it is the reference. A path read and edited ten times is
 * written out once.
 *
 * The index is carried from one window of a session to the next, so a reference keeps its meaning
 * across the whole of a reading.
 */

import { z } from "zod";

/** One path of the index: its reference is `[F<id>]`. */
export const IndexedFileSchema = z.object({
  id: z.number().int().positive(),
  path: z.string().min(1),
  /** Whether a call that edits files named it. */
  changed: z.boolean(),
});
export type IndexedFile = z.output<typeof IndexedFileSchema>;

/** The index: each id and each path is in it once, so a reference names one path. */
export const FileIndexSchema = z
  .object({ files: z.array(IndexedFileSchema) })
  .refine(
    ({ files }) => new Set(files.map((file) => file.id)).size === files.length && new Set(files.map((file) => file.path)).size === files.length,
    { message: "a file index holds each id and each path once" },
  );
export type FileIndex = z.output<typeof FileIndexSchema>;

export const EMPTY_FILE_INDEX: FileIndex = { files: [] };

/** The reference of a path in the index. */
export function fileRef(id: number): string {
  return `[F${String(id)}]`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The index as it grows over a reading: the paths it holds, and the references in a text. */
export class FileIndexer {
  readonly #files: IndexedFile[];
  readonly #byPath = new Map<string, IndexedFile>();
  /** The id the next path is given: after the highest one in use, so no two paths share a reference. */
  #nextId: number;

  constructor(from: FileIndex = EMPTY_FILE_INDEX) {
    this.#files = from.files.map((file) => ({ ...file }));
    this.#nextId = this.#files.reduce((highest, file) => Math.max(highest, file.id), 0) + 1;
    for (const file of this.#files) this.#byPath.set(file.path, file);
  }

  /**
   * The path as a call names it: whole, with its reference, the first time; the reference after.
   * A call that edits marks the path changed.
   */
  name(path: string, changed: boolean): string {
    const known = this.#byPath.get(path);
    if (known !== undefined) {
      if (changed) known.changed = true;
      return fileRef(known.id);
    }
    const file = { id: this.#nextId++, path, changed };
    this.#files.push(file);
    this.#byPath.set(path, file);
    return `${fileRef(file.id)} ${path}`;
  }

  /**
   * `text` with every mention of a path the index already holds replaced by its reference. A mention
   * is the whole path: not part of a longer word or path. The text is read once, from its start, so
   * a reference put in is never read again, and the longest path wins where two start together.
   */
  refer(text: string): string {
    if (this.#files.length === 0) return text;
    const paths = [...this.#files].sort((a, b) => b.path.length - a.path.length).map((file) => escapeRegExp(file.path));
    const mention = new RegExp(`(?<![\\w./~-])(?:${paths.join("|")})(?![\\w/-]|\\.\\w)`, "g");
    return text.replace(mention, (path) => fileRef(this.#byPath.get(path)!.id));
  }

  /** The index as it stands. */
  index(): FileIndex {
    return { files: this.#files.map((file) => ({ ...file })) };
  }
}
