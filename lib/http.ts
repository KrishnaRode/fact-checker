import "server-only";

/**
 * This is a no-auth local app: it must not become an open proxy or accept cross-site
 * state-changing requests. POST/DELETE require JSON and a same-origin (or absent) Origin;
 * browsers' Sec-Fetch-Site "cross-site" is rejected.
 */
export function rejectCrossOrigin(req: Request): Response | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return json({ code: "forbidden", message: "Cross-site requests are not allowed." }, 403);
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      /* invalid */
    }
    if (!host || originHost !== host) return json({ code: "forbidden", message: "Cross-origin requests are not allowed." }, 403);
  }
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) return json({ code: "unsupported_media_type", message: "Send JSON." }, 415);
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
