import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  main: {
    root,
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: { index: resolvePath('electron/main/index.ts') },
        // .cjs, not .js: the package.json here is "type": "module", so a plain .js file would be
        // misread as ESM despite being CJS-formatted.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    root,
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: { index: resolvePath('electron/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolvePath('renderer'),
    resolve: {
      alias: { '@': resolvePath('renderer/src') },
    },
    build: {
      outDir: resolvePath('dist/renderer'),
      rollupOptions: {
        input: { index: resolvePath('renderer/index.html') },
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
