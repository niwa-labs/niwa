/**
 * The input of an agent process: where the lines of the protocol are written.
 *
 * A line written to a child that is gone is not an error for the stream until its callback says so,
 * and a closed stream can be told in advance. Both are reported here, so that a message that did not
 * go out is never taken for one that did.
 */

import type { Writable } from "node:stream";

/** Whether the input can still take a line. */
export function inputOpen(input: Writable | undefined): input is Writable {
  return input !== undefined && input.writable && !input.destroyed;
}

/**
 * Write one line, ending it with a line feed. Throws at once when the input is closed or the stream
 * refuses the write; otherwise the promise settles when the stream has taken the line, or rejects
 * with the failure it reported for it.
 */
export function writeLine(input: Writable | undefined, line: string): Promise<void> {
  if (!inputOpen(input)) throw new Error("the agent's input is closed");
  let accepted!: () => void;
  let failed!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    accepted = resolve;
    failed = reject;
  });
  input.write(`${line}\n`, (error) => (error === null || error === undefined ? accepted() : failed(error)));
  return done;
}
