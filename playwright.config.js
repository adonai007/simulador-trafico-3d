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
  // V3: three spec files (e2e, v3-c1, v3-c2) of heavyweight WebGL sims at 4x
  // would otherwise run as parallel SwiftShader pages and starve each other
  // into waitForFunction timeouts (observed: rotating flakes, never assertion
  // failures; e2e-2 needs ~20 wall-s alone vs >30 s under any parallel load).
  // Serial = the Phase 0 baseline that ran 8/8 green in 3.1 m.
  workers: 1,
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
