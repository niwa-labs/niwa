/**
 * Cutting a long text in the middle.
 *
 * The start of a tool's output says what it did and the end how it ended, so both are kept and the
 * middle is cut, with a marker that says how much was there and where the whole of it is. An output
 * that ends in an error keeps more of its end, where the error is.
 */

/** Words that mark the end of an output as a failure: its end then matters more than its start. */
const FAILURE = /\b(error|exception|failed|fatal|traceback|panic|exit code|errno|denied)\b/i;

/** How much of the end of a text is looked at for a failure. */
const FAILURE_SCAN = 2_048;

/** What a cut is told: how many characters to keep, and where the whole text can be read. */
export interface CutOptions {
  /** The characters kept, the marker among them. */
  readonly keep: number;
  /** Where the whole text is, said in the marker: the locator of the record it came from. */
  readonly source: string;
}

/** The marker that stands for the middle of a text: how long the text was, and where it is whole. */
export function cutMarker(length: number, kept: number, source: string): string {
  return `…⟨cut ${String(length - kept)} of ${String(length)} chars, whole at ${source}⟩…`;
}

/** The marker when the full one does not fit: how much was cut, and nothing of where; the entry's source says where. */
function shortMarker(length: number, kept: number): string {
  return `…⟨cut ${String(length - kept)}⟩…`;
}

/**
 * `text` with its middle cut so that it holds at most `keep` characters, the marker among them. A
 * text that fits is returned as it is, and so is one the cut would not make shorter. The cut moves
 * to a line break when one is near, so a kept line is whole. Where the marker with its source does
 * not fit, a short one that only counts stands in; where not even that fits, the text is cut at
 * its end.
 */
export function cutMiddle(text: string, { keep, source }: CutOptions): string {
  if (text.length <= keep) return text;
  // The longest the marker can be: the count of what is removed has at most the digits of the length.
  const room = keep - cutMarker(text.length, 0, source).length;
  if (room < 16) {
    const short = keep - shortMarker(text.length, 0).length;
    if (short < 1) return cutEnd(text, keep);
    return `${text.slice(0, short)}${shortMarker(text.length, short)}`;
  }
  const failed = FAILURE.test(text.slice(-FAILURE_SCAN));
  let head = Math.floor(room * (failed ? 0.3 : 0.7));
  let tail = room - head;
  const headBreak = text.lastIndexOf("\n", head);
  if (headBreak > head / 2) head = headBreak + 1;
  const tailStart = text.length - tail;
  const tailBreak = text.indexOf("\n", tailStart);
  if (tailBreak !== -1 && tailBreak - tailStart < tail / 2) tail = text.length - (tailBreak + 1);
  const kept = head + tail;
  const cut = `${text.slice(0, head)}${cutMarker(text.length, kept, source)}${text.slice(text.length - tail)}`;
  return cut.length < text.length ? cut : text;
}

/** `text` cut at its end to at most `max` characters, an ellipsis marking the cut. */
export function cutEnd(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
