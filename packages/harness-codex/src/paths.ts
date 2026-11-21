/**
 * Where a Codex installation keeps its sessions, and how a rollout file is named.
 *
 * The native layout is `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`.
 * Codex compresses cold rollouts itself into the same file with a `.zst` suffix: the same JSONL,
 * in a zstd container (`codex-rs/rollout/src/compression.rs`).
 *
 * The id of the session is the uuid in the file name. Codex writes it into the first
 * `session_meta` as well, and the two agree; the file name is used because it is there even when
 * the session metadata is missing or unreadable.
 */

/** The name of a rollout file: `rollout-<...>-<uuid>.jsonl`. */
const ROLLOUT_NAME = /^rollout-.+-([0-9a-fA-F-]{36})\.jsonl$/;

/**
 * The suffix of the compressed copy of a rollout.
 *
 * It is `.zst`, not `.jsonl.zst`: the compressed file is the rollout with `.zst` added, so the
 * name of the rollout is the name without it.
 */
export const ZSTD_SUFFIX = ".zst";

/** The id in the name of a rollout file, or `null` when the name is not a rollout's. */
export function nativeIdOfFileName(name: string): string | null {
  const base = name.endsWith(ZSTD_SUFFIX) ? name.slice(0, -ZSTD_SUFFIX.length) : name;
  return ROLLOUT_NAME.exec(base)?.[1] ?? null;
}

/** Whether a file name is the compressed copy of a rollout. */
export function isCompressedName(name: string): boolean {
  return name.endsWith(ZSTD_SUFFIX);
}

/**
 * The base of a rollout path: the compressed copy is the same rollout, so the suffix is removed.
 *
 * It is what tells the two copies of one session apart from two sessions.
 */
export function baseOfArtifact(path: string): string {
  return path.endsWith(ZSTD_SUFFIX) ? path.slice(0, path.length - ZSTD_SUFFIX.length) : path;
}
