// Playwright config — e2e suite lands in Phase 7 (tests/e2e.spec.js).
// SIM_PORT overrides the target port (default 5173): with reuseExistingServer
// the port check can't tell WHICH app is listening, so when another project
// occupies 5173 run `SIM_PORT=<port> npx playwright test` against the real
// simulator dev server instead.
import { defineConfig } from '@playwright/test';

const port = Number(process.env.SIM_PORT || 5173);

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
  },
  webServer: {
    command: `npx vite dev --port ${port}`,
    port,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
