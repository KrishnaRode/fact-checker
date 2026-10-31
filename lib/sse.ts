/**
 * Incremental Server-Sent Events parser for fetch() streams (POST bodies cannot use native
 * EventSource). Handles events split across chunks, several events per chunk, CRLF/LF line
 * endings, comments and multi-line data fields.
 */
export class SSEParser {
  private buffer = "";

  constructor(private readonly onEvent: (data: string, event: string | null) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const m = this.buffer.match(/\r\n\r\n|\n\n|\r\r/);
      if (!m || m.index === undefined) break;
      const block = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      this.dispatch(block);
    }
  }

  /** Flush a trailing event without a terminating blank line (stream closed). */
  end(): void {
    if (this.buffer.trim()) this.dispatch(this.buffer);
    this.buffer = "";
  }

  private dispatch(block: string): void {
    const data: string[] = [];
    let event: string | null = null;
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(":")) continue;
      const idx = line.indexOf(":");
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? "" : line.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
    }
    if (data.length) this.onEvent(data.join("\n"), event);
  }
}
