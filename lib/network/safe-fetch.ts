import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { appConfig, budgets } from "@/app.config";
import { checkPublicUrl, isPublicAddress } from "./address";

/**
 * Safe fetch for internet content (articles, feeds, provider APIs).
 *
 * - URL policy: public http(s) only, no credentials, limited ports (address.ts).
 * - DNS rebinding: validation happens INSIDE the connection's lookup, so the address that is
 *   checked is the address that is connected to. No resolve-then-fetch race.
 * - Redirects are followed manually (max N) and every hop is revalidated.
 * - Body size is counted on the decoded (decompressed) stream; Content-Length is not trusted.
 * - Content types are allow-listed; PDFs and other binaries are reported as unsupported.
 *
 * The local Ollama connection does NOT use this path; it is a separate trusted transport.
 */

export class FetchError extends Error {
  constructor(
    public code:
      | "blocked_url"
      | "blocked_address"
      | "timeout"
      | "aborted"
      | "http_error"
      | "too_large"
      | "unsupported_type"
      | "too_many_redirects"
      | "network",
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** A connect-time lookup that only ever hands public addresses to the socket. */
export function createGuardedLookup(resolve: Resolver = systemResolver): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    resolve(hostname)
      .then((addrs) => {
        if (!addrs.length) throw Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" });
        const bad = addrs.find((a) => !isPublicAddress(a.address));
        if (bad) throw Object.assign(new Error(`Blocked non-public address for ${hostname}`), { code: "EBLOCKEDADDR" });
        if (options && (options as { all?: boolean }).all) callback(null, addrs);
        else callback(null, addrs[0]!.address, addrs[0]!.family);
      })
      .catch((err) => callback(err));
  }) as unknown as LookupFunction;
}

export function createGuardedAgent(resolve?: Resolver): Agent {
  return new Agent({
    connect: { lookup: createGuardedLookup(resolve), timeout: 5_000 },
    headersTimeout: 8_000,
    bodyTimeout: 8_000,
    connections: 8,
  });
}

let sharedAgent: Agent | null = null;
function agent(): Agent {
  sharedAgent ??= createGuardedAgent();
  return sharedAgent;
}

const TEXT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/json",
  "application/ld+json",
  "text/plain",
];

export type SafeResponse = {
  url: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  text: string;
  notModified: boolean;
};

export type SafeFetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  accept?: string;
  /** Tests inject a dispatcher bound to a fake resolver. */
  dispatcher?: Dispatcher;
  /** Return 304 responses instead of throwing (conditional revalidation). */
  allowNotModified?: boolean;
};

/** Caller signal + timeout via a plain controller (strong references, timer cleared by GC-safe close). */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
  timer.unref?.();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxBytes = opts.maxBytes ?? budgets.fetchMaxBytes;
  const signal = combineSignals(opts.signal, timeoutMs);
  let current = rawUrl;

  for (let hop = 0; hop <= budgets.fetchMaxRedirects; hop++) {
    const check = checkPublicUrl(current);
    if (!check.ok) throw new FetchError("blocked_url", check.reason);

    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(check.url.href, {
        redirect: "manual",
        signal,
        dispatcher: opts.dispatcher ?? agent(),
        headers: {
          "user-agent": appConfig.userAgent,
          accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
          "accept-language": "en",
          ...opts.headers,
        },
      });
    } catch (err) {
      throw classifyNetworkError(err, opts.signal);
    }

    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new FetchError("http_error", `Redirect without a location (${res.status}).`, res.status);
      current = new URL(loc, check.url).href;
      continue;
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined);
      if (!opts.allowNotModified) throw new FetchError("http_error", "Unexpected 304.", 304);
      return { url: check.url.href, status: 304, contentType: "", headers, text: "", notModified: true };
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const msg =
        res.status === 401 || res.status === 402 || res.status === 403
          ? "The site refused access (sign-in, paywall or bot protection)."
          : res.status === 404 || res.status === 410
            ? "The page was not found."
            : res.status === 429
              ? "The site is rate limiting requests."
              : `The site answered with HTTP ${res.status}.`;
      throw new FetchError("http_error", msg, res.status);
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const base = contentType.split(";")[0]!.trim();
    if (base && !TEXT_TYPES.includes(base)) {
      await res.body?.cancel().catch(() => undefined);
      const what = base === "application/pdf" ? "a PDF" : `a ${base} file`;
      throw new FetchError("unsupported_type", `This link is ${what}, which this version cannot read. Paste the relevant text instead.`);
    }

    const text = await readCapped(res.body as unknown as ReadableStream<Uint8Array> | null, maxBytes, opts.signal);
    return { url: check.url.href, status: res.status, contentType: base, headers, text, notModified: false };
  }
  throw new FetchError("too_many_redirects", "Too many redirects.");
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number, outer?: AbortSignal): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FetchError("too_large", "The page is larger than the safe reading limit.");
      }
      out += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw classifyNetworkError(err, outer);
  }
  return out + decoder.decode();
}

function classifyNetworkError(err: unknown, outer?: AbortSignal): FetchError {
  if (err instanceof FetchError) return err;
  if (outer?.aborted) return new FetchError("aborted", "Cancelled.");
  const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.code;
  if (code === "EBLOCKEDADDR") return new FetchError("blocked_address", "The link resolves to a non-public address.");
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT")
    return new FetchError("timeout", "The site took too long to respond.");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new FetchError("network", "The site's address could not be resolved.");
  return new FetchError("network", "The site could not be reached.");
}

/* ── Per-host politeness + in-flight coalescing ───────────────────────────── */

const lastHit = new Map<string, number>();
const inflight = new Map<string, Promise<SafeResponse>>();

/** Space requests to the same host by at least `minGapMs`, respecting cancellation. */
export async function politeFetch(url: string, opts: SafeFetchOptions & { minGapMs?: number } = {}): Promise<SafeResponse> {
  const key = `${url}|${JSON.stringify(opts.headers ?? {})}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      /* safeFetch reports invalid URLs */
    }
    const gap = opts.minGapMs ?? 800;
    const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
    if (host) lastHit.set(host, Math.max(Date.now(), (lastHit.get(host) ?? 0) + gap));
    if (wait > 0) await sleep(wait, opts.signal);
    return safeFetch(url, opts);
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new FetchError("aborted", "Cancelled."));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new FetchError("aborted", "Cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
