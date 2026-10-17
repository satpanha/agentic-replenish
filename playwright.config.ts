import { defineConfig, devices } from "@playwright/test";

/**
 * StockPulse AMD tests.
 * - tests/e2e/logic.spec.ts: the frontend's deterministic calculations (no browser).
 * - tests/e2e/*.spec.ts: the full app in Chromium against a real engine.
 * The web server builds the TypeScript frontend and starts the FastAPI engine on its own port with a
 * throwaway database, so test runs never touch your demo data.
 */
const PORT = 8799;
const PYTHON = process.env.PYTHON || ".venv/bin/python";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1, // one engine, shared state: run in order
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `rm -f var/e2e.db && npm run build && DB_PATH=var/e2e.db ${PYTHON} -m uvicorn app.main:app --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
