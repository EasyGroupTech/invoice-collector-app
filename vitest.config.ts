import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * One shared config for the whole monorepo's single `vitest run` invocation (root `npm test`) —
 * phase 1.18 needed this repo's first jsdom + React Testing Library environment, for ic-core's
 * renderer alone. `environmentMatchGlobs` (the old way to scope this by path) no longer exists in
 * vitest 4 — every renderer E2E test file instead opts in per-file via a leading
 * `// @vitest-environment jsdom` comment (still-supported, documented mechanism), so the default
 * stays `node` for every other package's plain test files, untouched. `react()` is safe to apply
 * globally — it only transforms JSX-containing files, a no-op for everything else in the
 * workspace.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(root, 'packages/ic-core/renderer/src'),
    },
  },
  test: {
    setupFiles: [path.join(root, 'packages/ic-core/renderer/src/e2e/setup.ts')],
  },
});
