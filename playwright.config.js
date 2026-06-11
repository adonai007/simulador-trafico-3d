// Playwright config — e2e suite lands in Phase 7 (tests/e2e.spec.js).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  webServer: {
    command: 'npx vite dev --port 5173',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
