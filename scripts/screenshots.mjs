/**
 * Regenerate the README screenshots from the real app and the real extension.
 *
 *   NEXT_DIST_DIR=.next-verify npm run build && npm run build:extension
 *   NEXT_DIST_DIR=.next-verify FACTCHECK_DATA_DIR=.data/shots npx next start -H 127.0.0.1 -p 3026 &
 *   node scripts/screenshots.mjs            # needs Ollama for the AI-mode shots
 *
 * Writes docs/screenshots/*.png. App shots use the fictional demo corpus (stable); the
 * extension's evidence-only shots use live news, so they show whatever is current.
 */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP = process.env.SHOTS_APP ?? "http://127.0.0.1:3026";
const OUT = path.resolve("docs/screenshots");
const DIST = path.resolve("extension/dist");
const EXT_ID = "jkccdjdinghdfoampelfceigjgkbkdfi";
const CLOSURE = "BREAKING: The Riverbend Museum has shut down permanently from today! Share before they delete this!!";
await mkdir(OUT, { recursive: true });

const shot = async (page, name, opts = {}) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
  console.log(`  ✓ ${name}.png`);
};

// ── App (demo corpus: deterministic sources) ─────────────────────────────────
const browser = await chromium.launch();
const app = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await app.goto(APP);
await app.evaluate(() => localStorage.setItem("fact-checker:mode", "live"));
await app.reload();
await app.waitForTimeout(800);
await shot(app, "01-home");

await app.evaluate(() => localStorage.setItem("fact-checker:mode", "demo"));
await app.goto(`${APP}/?q=${encodeURIComponent(CLOSURE)}`);
await app.getByLabel("Claim, forward or news article URL").press("Enter");
await app.waitForTimeout(2_500);
await shot(app, "02-investigating");
await app.getByText(/Contradicted by the evidence|Supported by the evidence|Not enough evidence|Mixed findings|Investigation incomplete/).first().waitFor({ timeout: 120_000 });
await app.waitForTimeout(1_200);
await app.evaluate(() => window.scrollTo(0, 0));
await shot(app, "03-verdict");

await app.locator("button[aria-label^='Open evidence passage']").first().click();
await app.waitForTimeout(600);
await shot(app, "04-evidence-inspector");
await app.keyboard.press("Escape");

await app.getByText("Evidence map & sources").click();
await app.locator("svg[aria-label^='Evidence map']").scrollIntoViewIfNeeded();
await app.waitForTimeout(600);
await shot(app, "05-evidence-map");

await app.goto(`${APP}/how-it-works`);
await app.waitForTimeout(800);
await shot(app, "06-how-it-works", { fullPage: false });
await app.getByRole("button", { name: "Check all feeds now" }).click();
await app.getByRole("button", { name: "Checking all feeds…" }).waitFor({ timeout: 5_000 }).catch(() => undefined);
await app.getByRole("button", { name: "Check all feeds now" }).waitFor({ timeout: 90_000 });
await app.locator("#sources").scrollIntoViewIfNeeded();
await app.evaluate(() => window.scrollBy(0, -20));
await app.waitForTimeout(500);
await shot(app, "07-live-sources");
await browser.close();

// ── Extension (loaded unpacked) ──────────────────────────────────────────────
const ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), `fc-shots-${Date.now()}`), {
  channel: "chromium",
  viewport: { width: 420, height: 900 },
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});
if (!ctx.serviceWorkers().length) await ctx.waitForEvent("serviceworker");

const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${EXT_ID}/sidepanel.html?demo=1`);
await ext.evaluate((app) => chrome.storage.local.set({ appUrl: app, forceRules: false }), APP);
await ext.reload();
await ext.locator("#claim").fill(CLOSURE);
await ext.keyboard.press("Enter");
await ext.locator("#result").waitFor({ state: "visible", timeout: 120_000 });
await ext.waitForTimeout(500);
await shot(ext, "08-extension-ai-mode");

await ext.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
await ext.evaluate(() => chrome.storage.local.set({ appUrl: "http://127.0.0.1:9", forceRules: true }));
await ext.evaluate(() => chrome.runtime.sendMessage({ type: "refresh-index" }));
for (const [name, claim] of [
  ["09-extension-no-ai-same-details", process.env.SHOTS_TRUE ?? "The Gujarat government will grant 15-day Diwali parole to 143 prisoners."],
  ["10-extension-no-ai-opposite", process.env.SHOTS_FAKE ?? "Gujarat is releasing 143 prisoners permanently for Diwali so they can burst crackers."],
]) {
  await ext.reload();
  await ext.locator("#claim").fill(claim);
  await ext.keyboard.press("Enter");
  await ext.locator("#result").waitFor({ state: "visible", timeout: 120_000 });
  await ext.waitForTimeout(400);
  await shot(ext, name);
}
// Settings with the real default address; evidence-only is forced so the script never
// contacts an app the user may be running on that port.
await ext.evaluate(() => chrome.storage.local.set({ appUrl: "http://127.0.0.1:3016", forceRules: true }));
await ext.reload();
await ext.locator("#mode-label").filter({ hasText: "Evidence-only" }).waitFor({ timeout: 10_000 });
await ext.locator("#mode").click();
await ext.waitForTimeout(800);
await shot(ext, "11-extension-settings");

const mgmt = await ctx.newPage();
await mgmt.setViewportSize({ width: 1280, height: 720 });
await mgmt.goto("chrome://extensions");
await mgmt.waitForTimeout(800);
// Match the README steps: Developer mode on, so "Load unpacked" is visible.
await mgmt.getByRole("button", { name: /Developer mode/ }).or(mgmt.getByRole("switch", { name: /Developer mode/ })).first().click();
await mgmt.waitForTimeout(800);
await shot(mgmt, "12-chrome-extensions-page");
await ctx.close();
console.log(`Saved to ${path.relative(process.cwd(), OUT)}/`);
