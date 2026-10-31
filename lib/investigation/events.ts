import { EventPayloads, InvestigationEventSchema, type EventPayload, type EventType, type InvestigationEvent } from "@/lib/contracts";

/**
 * Typed event channel for one investigation run. Every event is validated against the
 * contract before it leaves the server; payloads never carry secrets, page bodies or
 * model reasoning — only action summaries and source-derived findings.
 */
export class EventChannel {
  private sequence = 0;
  private readonly started = Date.now();
  private closed = false;
  readonly log: InvestigationEvent[] = [];
  firstEvidenceMs: number | null = null;

  constructor(
    readonly runId: string,
    private readonly sink: (e: InvestigationEvent) => void,
  ) {}

  emit<T extends EventType>(type: T, payload: EventPayload<T>): void {
    if (this.closed) return;
    const elapsedMs = Date.now() - this.started;
    if ((type === "passage_selected" || type === "source_fetched") && this.firstEvidenceMs == null) this.firstEvidenceMs = elapsedMs;
    const event = InvestigationEventSchema.parse({
      runId: this.runId,
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
      elapsedMs,
      type,
      payload: EventPayloads[type].parse(payload),
    });
    this.log.push(event);
    this.sink(event);
  }

  elapsed(): number {
    return Date.now() - this.started;
  }

  close(): void {
    this.closed = true;
  }
}

export function encodeSSE(event: InvestigationEvent): string {
  return `event: ${event.type}\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
}
