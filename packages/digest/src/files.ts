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

export const FileIndexSchema = z.object({ files: z.array(IndexedFileSchema) });
export type FileIndex = z.output<typeof FileIndexSchema>;

export const EMPTY_FILE_INDEX: FileIndex = { files: [] };

/** The reference of a path in the index. */
export function fileRef(id: number): string {
  return `[F${String(id)}]`;
}

/** The index as it grows over a reading: the paths it holds, and the references in a text. */
export class FileIndexer {
  readonly #files: IndexedFile[];
  readonly #byPath = new Map<string, IndexedFile>();

  constructor(from: FileIndex = EMPTY_FILE_INDEX) {
    this.#files = from.files.map((file) => ({ ...file }));
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
    const file = { id: this.#files.length + 1, path, changed };
    this.#files.push(file);
    this.#byPath.set(path, file);
    return `${fileRef(file.id)} ${path}`;
  }

  /** `text` with every path the index already holds replaced by its reference, the longest first. */
  refer(text: string): string {
    let referred = text;
    for (const file of [...this.#files].sort((a, b) => b.path.length - a.path.length)) {
      if (referred.includes(file.path)) referred = referred.split(file.path).join(fileRef(file.id));
    }
    return referred;
  }

  /** The index as it stands. */
  index(): FileIndex {
    return { files: this.#files.map((file) => ({ ...file })) };
  }
}
