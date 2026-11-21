/**
 * A reader of server-sent events over a byte stream.
 *
 * The cockpit reads the record feed with `fetch` rather than `EventSource`: it controls the
 * position to resume from, can stop the read with an abort signal, and sees HTTP errors.
 */

export type ServerEvent = {
  /** The `id:` field, or undefined when the event has none. */
  id: string | undefined;
  /** The `event:` field; `message` when absent. */
  event: string;
  data: string;
};

/** Splits a stream of text chunks into events. Comments and events without data are skipped. */
export async function* serverEvents(chunks: AsyncIterable<string>): AsyncGenerator<ServerEvent, void, undefined> {
  let buffer = "";
  let id: string | undefined;
  let event = "message";
  let data: string[] = [];

  function* lines(): Generator<ServerEvent, void, undefined> {
    for (;;) {
      const end = buffer.search(/\r\n|\r|\n/);
      if (end < 0) return;
      // A lone `\r` at the end of the buffer may be the first half of `\r\n`: wait for more.
      if (buffer[end] === "\r" && end === buffer.length - 1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));

      if (line === "") {
        if (data.length > 0) yield { id, event, data: data.join("\n") };
        id = undefined;
        event = "message";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "id") id = value;
      else if (field === "event") event = value;
    }
  }

  for await (const chunk of chunks) {
    buffer += chunk;
    yield* lines();
  }
  // The stream is over, so a final `\r` is a whole line end.
  if (buffer.endsWith("\r")) {
    buffer += "\n";
    yield* lines();
  }
}

/** The text of a response body, chunk by chunk. */
export async function* textChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    finished = true;
    const tail = decoder.decode();
    if (tail !== "") yield tail;
  } finally {
    // A reader that stops early closes the connection instead of leaving it open.
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
