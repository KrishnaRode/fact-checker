import ipaddr from "ipaddr.js";

/**
 * Public-address policy for every outbound fetch of internet content.
 * Only the "unicast" range is allowed; loopback, private, link-local (incl. cloud metadata
 * 169.254.169.254), CGNAT, multicast, reserved, unspecified, broadcast, documentation,
 * 6to4/Teredo/NAT64 wrappers etc. are all rejected. IPv4-mapped IPv6 is unwrapped first.
 */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
  }
  const range = parsed.range();
  if (parsed.kind() === "ipv4") return range === "unicast";
  // IPv6: only global unicast. ipaddr labels it "unicast"; anything else is non-public.
  return range === "unicast";
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

/** Hostname-level checks that do not need DNS. IP literals are judged directly. */
export function hostnameVerdict(hostname: string): { ok: true; literal: boolean } | { ok: false; reason: string } {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "Missing host." };
  if (ipaddr.isValid(host)) {
    return isPublicAddress(host) ? { ok: true, literal: true } : { ok: false, reason: "That address is not a public internet host." };
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "That host is local or internal." };
  }
  if (!host.includes(".")) return { ok: false, reason: "That host is not a public domain name." };
  return { ok: true, literal: false };
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Validate a user- or provider-supplied URL before any network activity.
 * The WHATWG parser normalises alternate IPv4 encodings (0x7f000001, 2130706433, 0177.0.0.1)
 * into dotted form, so they are caught by the address policy above.
 */
export function checkPublicUrl(raw: string | URL): UrlCheck {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw.trim()) : new URL(raw.href);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "Only http and https links can be read." };
  if (url.username || url.password) return { ok: false, reason: "Links with embedded credentials are not allowed." };
  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, reason: `Port ${url.port} is not allowed.` };
  const verdict = hostnameVerdict(url.hostname);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  url.hash = "";
  return { ok: true, url };
}
