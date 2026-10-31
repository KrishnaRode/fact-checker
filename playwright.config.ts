import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3036);

/**
 * E2E runs against a PRODUCTION build in a separate dist dir and a separate data dir, on its
 * own port, so it never touches a server on 3016 or the user's cache.
 * Build first: `NEXT_DIST_DIR=.next-verify npm run build`.
 * Flows that need the local model skip themselves (with a reason) when Ollama is unavailable.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx next start -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { NEXT_DIST_DIR: ".next-verify", FACTCHECK_DATA_DIR: ".data/e2e" },
  },
});
