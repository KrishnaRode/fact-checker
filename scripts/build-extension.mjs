/**
 * Build the companion Chrome extension into extension/dist (load it via chrome://extensions →
 * Developer mode → Load unpacked → extension/dist).
 *
 * Host permissions are DERIVED from the feed lists in app.config.ts: the extension can only
 * read those publishers' sites, plus the Fact Checker app on this computer.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "extension", "dist");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

// Stable extension ID (jkccdjdinghdfoampelfceigjgkbkdfi): the app allows exactly this origin.
const PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6e/gDnJNFH2fwOZqjuBf0VSDIWx/iUMDikC/XWIuOB3V3TVouOWK4dzEfUQ16g8+wjdwCw3nZKhJUyjwL3TB1L8LshBQWVHHrTm4IqxyaGbKV55NqM9OgirVUb3AUqSlRmrmbcOnulAthzYRG7mR0qvagpUtYvEiV9FABZmb5GsyvpC9Fq6GW9hGk95NIqk1+pwfo21oEWnCa58IncU6w1fEWzTU/qHE7tP0Mv8o2Q0ehkqQWWr41drASq2aeJH9XUbO+i3DkgdZnxIeliWZ50/JuJC6ZRymDAfIKbDl/7pPRtTy3sZBLlH+oMOEzemCkbbBmHS7jjO2nMtzzdA4IwIDAQAB";

// Feed hosts → registrable domains (articles live on the publisher's main domain).
const config = await readFile(path.join(root, "app.config.ts"), "utf8");
const hosts = [...new Set([...config.matchAll(/url: "https:\/\/([^/"]+)/g)].map((m) => m[1]))];
const registrable = (h) => {
  const parts = h.split(".");
  return parts.slice(/\.(co|com|org|net)\.[a-z]{2}$/.test(h) ? -3 : -2).join(".");
};
const domains = new Set(hosts.map(registrable));
domains.add("ndtv.com"); // NDTV's feeds are served by feedburner.com
domains.add("bbc.com");
domains.add("bbc.co.uk");
domains.add("npr.org");
const hostPermissions = ["http://127.0.0.1/*", "http://localhost/*", ...[...domains].sort().map((d) => `https://*.${d}/*`)];

const manifest = {
  manifest_version: 3,
  name: "Fact Checker",
  short_name: "Fact Checker",
  version: pkg.version,
  description: "Before you believe it. Right-click any text to check it against the news — local AI via the Fact Checker app, or evidence-only rules with no AI.",
  key: PUBLIC_KEY,
  minimum_chrome_version: "116",
  icons: { 16: "icons/icon-16.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
  action: { default_title: "Fact Checker", default_icon: { 16: "icons/icon-16.png", 48: "icons/icon-48.png" } },
  side_panel: { default_path: "sidepanel.html" },
  background: { service_worker: "background.js", type: "module" },
  permissions: ["contextMenus", "sidePanel", "storage"],
  host_permissions: hostPermissions,
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: { background: "extension/src/background.ts", sidepanel: "extension/src/sidepanel.ts" },
  absWorkingDir: root,
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
  sourcemap: false,
  tsconfig: path.join(root, "tsconfig.json"),
  alias: { "node:crypto": path.join(root, "extension/src/crypto-shim.ts") },
  define: { "process.env.FACTCHECK_DISABLE_SOCIAL": "undefined", "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
await cp(path.join(root, "extension", "static"), out, { recursive: true });
await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Built extension v${manifest.version} → extension/dist (${hostPermissions.length} host permissions)`);
