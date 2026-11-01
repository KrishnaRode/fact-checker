import { expect, test, type Page } from "@playwright/test";

const CLOSURE = "BREAKING: The Riverbend Museum has shut down permanently from today! Share before they delete this!!";
const VERDICT_LABELS = /Supported by the evidence|Contradicted by the evidence|Misleading \/ missing context|Not enough evidence|Not fact-checkable|Mixed findings|Investigation incomplete/;

async function modelReady(page: Page): Promise<boolean> {
  const h = await (await page.request.get("/api/health")).json();
  return h.ollama.reachable && h.ollama.modelInstalled;
}

async function useDemoMode(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("fact-checker:mode", "demo"));
  await page.reload();
  await expect(page.getByText("Demo mode · bundled fictional evidence")).toBeVisible();
}

test("home: hero, composer, samples and keyboard behaviour", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Before you believe it." })).toBeVisible();
  await expect(page.getByText("Bring a claim. Follow the evidence.")).toBeVisible();
  const box = page.getByLabel("Claim, forward or news article URL");
  await expect(box).toHaveAttribute("placeholder", /Something doesn't sound right\?/);
  await expect(page.getByRole("button", { name: /Investigate/ })).toBeDisabled();
  await box.fill("first line");
  await box.press("Shift+Enter");
  await box.pressSequentially("second line");
  await expect(box).toHaveValue("first line\nsecond line");
  // Never truncates: oversized input disables the action and says by how much.
  await box.fill("a".repeat(12_050));
  await expect(page.getByText(/50 characters over the 12,000 limit/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Investigate/ })).toBeDisabled();
  await expect(box).toHaveValue("a".repeat(12_050));
});

test("demo flow: real pipeline events, verdict, evidence inspector, map and follow-up", async ({ page }) => {
  test.skip(!(await modelReady(page)), "Ollama or the configured model is not available");
  expect((await page.request.delete("/api/cache")).ok()).toBe(true);
  await useDemoMode(page);
  await page.getByRole("button", { name: /Permanent closure forward/ }).click();
  await expect(page.getByLabel("Claim, forward or news article URL")).toBeFocused();
  await page.keyboard.press("Enter");
  // Immediate acknowledgement, then genuine stream activity.
  await expect(page.getByText("Investigating", { exact: true })).toBeVisible({ timeout: 2_000 });
  await expect(page.getByText(/Read Kestrel Bay Museums Trust|counted as one source|Found an original source/).first()).toBeVisible();
  // A labelled verdict (the exact label is the local model's validated judgement).
  await expect(page.getByText(VERDICT_LABELS).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Demo · bundled evidence").first()).toBeVisible();
  // Evidence inspector opens from a passage and closes with Escape.
  await page.locator("button[aria-label^='Open evidence passage'], li > button:has(.font-mono)").first().click();
  const dialog = page.getByRole("dialog", { name: "Evidence details" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Exact extracted text/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Evidence map with keyboard-selectable nodes.
  await page.getByText("Evidence map & sources").click();
  const node = page.locator("svg [role=button]").first();
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Evidence details" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Follow-up grounded in the same evidence.
  await page.getByPlaceholder("Ask about the evidence…").fill("What was changed in the forward?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Reading the evidence…")).toBeVisible();
  await expect(page.getByText("Reading the evidence…")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("p", { hasText: "Demo · bundled evidence" }).last()).toBeVisible();

  // The same claim again is an exact cache hit: served at once and labelled as cached.
  await page.getByRole("button", { name: "New investigation", exact: true }).click();
  await page.getByLabel("Claim, forward or news article URL").fill(CLOSURE);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Cached result/).first()).toBeVisible({ timeout: 3_000 });
  expect(Date.now() - t0).toBeLessThan(3_000);
});

test("stop cancels the run and retry is offered", async ({ page }) => {
  test.skip(!(await modelReady(page)), "Ollama or the configured model is not available");
  await useDemoMode(page);
  await page.getByLabel("Claim, forward or news article URL").fill("The Riverbend Museum closes for roof maintenance from 26 October. Entry will be free for everyone when it reopens.");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Investigating", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).or(page.getByRole("button", { name: "Stop investigating" })).first().click();
  await expect(page.getByText("Stopped. Nothing was concluded.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  // No verdict is shown for a stopped run.
  await expect(page.getByText(/Supported by the evidence|Contradicted by the evidence/)).toHaveCount(0);
});

test("settings drawer: coverage, model and local data reset", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Open settings/ }).click();
  const drawer = page.getByRole("dialog", { name: "Settings & coverage" });
  await expect(drawer.getByRole("heading", { name: "Local model" })).toBeVisible();
  await expect(drawer.getByText(/Sources · (selected-source coverage|broader web search enabled)/)).toBeVisible();
  await drawer.getByRole("button", { name: "Reset local data" }).click();
  await drawer.getByRole("button", { name: "Delete" }).click();
  await expect(drawer.getByText("Local data deleted.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("cross-origin state-changing requests are rejected", async ({ request }) => {
  const res = await request.post("/api/investigate", { data: { input: "x y z" }, headers: { origin: "https://evil.example", "content-type": "application/json" } });
  expect(res.status()).toBe(403);
  const form = await request.post("/api/investigate", { form: { input: "x y z" } });
  expect(form.status()).toBe(415);
});

test.describe("mobile 360px", () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  test("no horizontal overflow; controls stay reachable; result renders", async ({ page }) => {
    await page.goto("/");
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.getByRole("button", { name: /Investigate/ })).toBeInViewport();
    test.skip(!(await modelReady(page)), "Ollama or the configured model is not available");
    await useDemoMode(page);
    await page.getByLabel("Claim, forward or news article URL").fill(CLOSURE);
    await page.getByRole("button", { name: /Investigate/ }).tap();
    await expect(page.getByText(VERDICT_LABELS).first()).toBeVisible({ timeout: 60_000 });
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByText("Evidence map & sources").click();
    // Narrow screens default to the list view of the evidence map.
    await expect(page.getByRole("tab", { name: "list" })).toHaveAttribute("aria-selected", "true");
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the investigating ring does not spin", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("fact-checker:mode", "demo"));
    await page.reload();
    // Hold the stream open long enough to inspect the running state.
    await page.route("/api/investigate", async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue();
    });
    await page.getByLabel("Claim, forward or news article URL").fill(CLOSURE);
    await page.keyboard.press("Enter");
    const spinner = page.locator(".motion-spin").first();
    await expect(spinner).toBeAttached();
    expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });
});

test("How it works page: pipeline, AI role and a live list of every source", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "How it works", exact: true }).click();
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  await expect(page.getByText("What the local AI does")).toBeVisible();
  await expect(page.getByText("What the AI does not do")).toBeVisible();
  await expect(page.getByText(/55 feeds from 13 publishers/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Hindustan Times").first()).toBeVisible();
  await expect(page.getByText("Reddit")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
