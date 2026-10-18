import { defineConfig } from 'vitest/config';
// e2e/ は Playwright（npm run test:e2e）で実行するので、vitest の対象から外す
export default defineConfig({ test: { globals: true, testTimeout: 30000, exclude: ['e2e/**', 'node_modules/**', 'demo/**'] } });
