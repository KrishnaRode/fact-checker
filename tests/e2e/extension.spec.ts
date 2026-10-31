import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";

/**
 * The companion extension, loaded unpacked into Chromium. AI mode talks to the e2e app server
 * (demo corpus, real local model); evidence-only mode fetches live public feeds.
 */
const EXT_ID = "jkccdjdinghdfoampelfceigjgkbkdfi";
const APP = `http://127.0.0.1:${process.env.E2E_PORT ?? 3036}`;
const DIST = path.resolve("extension/dist");
let ctx: BrowserContext;

test.beforeAll(async () => {
  execFileSync("node", ["scripts/build-extension.mjs"], { stdio: "inherit" });
  ctx = await chromium.launchPersistentContext(path.join(os.tmpdir(), `fc-ext-${Date.now()}`), {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
});
test.afterAll(async () => ctx?.close());

async function panel(query = "") {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  expect(new URL(sw.url()).host).toBe(EXT_ID);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/sidepanel.html${query}`);
  return page;
}

test("loads with the stable ID and uses the local app (AI mode)", async () => {
  test.setTimeout(120_000);
  const page = await panel("?demo=1");
  await page.evaluate((app) => chrome.storage.local.set({ appUrl: app, forceRules: false }), APP);
  const health = await (await fetch(`${APP}/api/health`)).json();
  test.skip(!health.ollama?.modelInstalled, "Local model unavailable");
  await page.reload();
  // Submit immediately, while the connection check may still be running: AI mode must win.
  await page.locator("#claim").fill("BREAKING: The Riverbend Museum has shut down permanently from today! Share before they delete this!!");
  await page.keyboard.press("Enter");
  await expect(page.locator("#mode-label")).toHaveText("AI · local · demo");
  await expect(page.locator("#result")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("#result")).toContainText("Demo · bundled fictional evidence");
  await expect(page.locator("#result .label")).toContainText(/Supported|Contradicted|Misleading|Not enough evidence|Not fact-checkable|Mixed|incomplete/i);
  await expect(page.getByRole("button", { name: "Open full investigation" })).toBeVisible();
});

test("falls back to evidence-only mode without the app, and decides by rules", async () => {
  test.setTimeout(120_000);
  const page = await panel();
  await page.evaluate(() => chrome.storage.local.set({ appUrl: "http://127.0.0.1:9", forceRules: false }));
  await page.reload();
  await expect(page.locator("#mode-label")).toHaveText("Evidence-only · no AI");
  await page.locator("#claim").fill("Did Mumbai police arrest anyone this week?");
  await page.keyboard.press("Enter");
  await expect(page.locator("#result")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("#result")).toContainText("Evidence-only mode · no AI");
  await expect(page.locator("#result .label")).toContainText(/Same details in independent reports|Reports say the opposite|Same topic — read carefully|Reports differ on details|Reports mention a denial|Reports conflict|fact-checker disputes|No matching coverage found/);
  await expect(page.locator("#result")).toContainText("Keywords: Mumbai");
});

test("a right-click handoff (pending claim) fills the panel and starts a check", async () => {
  const page = await panel();
  await page.evaluate(() => chrome.storage.local.set({ appUrl: "http://127.0.0.1:9", forceRules: true }));
  await page.reload();
  await page.evaluate(() => chrome.storage.session.set({ pendingClaim: { text: "Kestrel Bay will be the best city in the world by 2040.", at: Date.now() } }));
  await expect(page.locator("#claim")).toHaveValue("Kestrel Bay will be the best city in the world by 2040.");
  await expect(page.locator("#result .label")).toContainText("Opinion or prediction", { timeout: 60_000 });
});
