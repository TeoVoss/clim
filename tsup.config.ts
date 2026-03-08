import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    outDir: 'dist',
    outExtension: () => ({ js: '.mjs' }),
    target: 'node22',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
    sourcemap: true,
  },
  {
    entry: { daemon: 'src/daemon/index.ts' },
    format: ['esm'],
    outDir: 'dist',
    outExtension: () => ({ js: '.mjs' }),
    target: 'node22',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
  },
]);
