"use client";

import { Check, CircleDashed, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type FeedStatus = {
  id: string;
  publisher: string;
  url: string;
  tags: string[];
  kind: "general" | "topic";
  state: "ok" | "failing" | "not_fetched";
  items: number;
  newest: string | null;
  checkedAt: string | null;
  note: string | null;
};
type Service = { id: string; name: string; kind: string; enabled: boolean; note: string };
type Payload = { feeds: FeedStatus[]; services: Service[]; excluded: { name: string; reason: string }[]; at: string };

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};
/** "city:pune" → "Pune"; topics joined ("Politics & crime"); national/world when untagged. */
const cap = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
const label = (tags: string[]) => {
  const city = tags.find((t) => t.startsWith("city:"));
  if (city) return cap(city.slice(5));
  const topics = tags.filter((t) => t.startsWith("topic:")).map((t) => t.slice(6));
  if (topics.length) return cap(topics.join(" & "));
  return tags.includes("region:india") ? "India" : "World";
};

function State({ s }: { s: FeedStatus["state"] }) {
  if (s === "ok") return <span className="inline-flex items-center gap-1 text-supported"><Check size={13} aria-hidden /> answering</span>;
  if (s === "failing") return <span className="inline-flex items-center gap-1 text-contradicted"><X size={13} aria-hidden /> failing</span>;
  return <span className="inline-flex items-center gap-1 text-text-faint"><CircleDashed size={13} aria-hidden /> not fetched yet</span>;
}

/** Live table of every feed, grouped by publisher, plus search services and exclusions. */
export function SourceStatus() {
  const [data, setData] = useState<Payload | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (check = false) => {
    try {
      const res = await fetch("/api/sources", { method: check ? "POST" : "GET", headers: check ? { "content-type": "application/json" } : undefined, cache: "no-store" });
      setData((await res.json()) as Payload);
      setError(null);
    } catch {
      setError("Could not load source status.");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/sources", { cache: "no-store" })
      .then((r) => r.json() as Promise<Payload>)
      .then((d) => alive && setData(d))
      .catch(() => alive && setError("Could not load source status."));
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, FeedStatus[]>();
    for (const f of data?.feeds ?? []) m.set(f.publisher, [...(m.get(f.publisher) ?? []), f]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const ok = data?.feeds.filter((f) => f.state === "ok").length ?? 0;
  const items = data?.feeds.reduce((n, f) => n + f.items, 0) ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-text-muted" aria-live="polite">
          {data ? (
            <>
              <span className="text-text">{data.feeds.length} feeds</span> from {groups.length} publishers · {ok} answering · {items.toLocaleString("en-IN")} headlines held right now
            </>
          ) : error ? (
            <span className="text-contradicted">{error}</span>
          ) : (
            "Loading live status…"
          )}
        </p>
        <button type="button" onClick={() => { setChecking(true); void load(true); }} disabled={checking} className="inline-flex items-center gap-2 rounded-full border border-border-strong px-4 py-2 text-[13.5px] text-text hover:border-text-faint disabled:opacity-50">
          <RefreshCw size={14} className={checking ? "motion-spin animate-spin-slow" : ""} aria-hidden /> {checking ? "Checking all feeds…" : "Check all feeds now"}
        </button>
      </div>

      <div className="space-y-4">
        {groups.map(([publisher, list]) => (
          <details key={publisher} className="group rounded-2xl border border-border bg-panel/60 px-4 py-3" open={publisher === "The Times of India" || publisher === "Hindustan Times"}>
            <summary className="flex items-center justify-between gap-3 text-[15px] text-text">
              <span>
                {publisher} <span className="text-[13px] text-text-faint">· {list.length} feed{list.length === 1 ? "" : "s"} · {list.filter((f) => f.state === "ok").length} answering</span>
              </span>
              <span className="text-text-faint transition group-open:rotate-180" aria-hidden>▾</span>
            </summary>
            <div className="scroll-thin mt-3 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[13px]">
                <thead className="text-text-faint">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Feed</th>
                    <th className="py-1.5 pr-3 font-medium">Used</th>
                    <th className="py-1.5 pr-3 font-medium">Status</th>
                    <th className="py-1.5 pr-3 font-medium">Headlines</th>
                    <th className="py-1.5 font-medium">Newest item</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {list.map((f) => (
                    <tr key={f.id} title={f.note ?? undefined}>
                      <td className="py-1.5 pr-3">
                        <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-strong hover:text-text">
                          {f.kind === "general" ? "General" : label(f.tags)}
                        </a>
                      </td>
                      <td className="py-1.5 pr-3 text-text-muted">{f.kind === "general" ? "Every check" : "When the claim mentions it"}</td>
                      <td className="py-1.5 pr-3"><State s={f.state} /></td>
                      <td className="py-1.5 pr-3 tabular-nums text-text-muted">{f.items || "—"}</td>
                      <td className="py-1.5 text-text-muted">{ago(f.newest)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>

      {data && (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Search services</h3>
            <ul className="space-y-2">
              {data.services.map((s) => (
                <li key={s.id} className="rounded-xl border border-border bg-bg-soft/60 p-3 text-[13.5px]">
                  <p className="flex items-center justify-between gap-2 text-text">
                    {s.name}
                    <span className={`text-[12px] ${s.enabled ? "text-supported" : "text-text-faint"}`}>{s.enabled ? "On" : s.kind === "optional" ? "Needs your key" : "Off"}</span>
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-text-faint">{s.note}</p>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Evaluated and not used</h3>
            <ul className="space-y-2">
              {data.excluded.map((x) => (
                <li key={x.name} className="rounded-xl border border-border bg-bg-soft/60 p-3 text-[13.5px]">
                  <p className="text-text">{x.name}</p>
                  <p className="mt-0.5 text-[12.5px] text-text-faint">{x.reason}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
