// Bundle the CLI into one self-contained Node script (workspace deps inlined
// from their TS source, so no build-order or publish-time resolution issues).
// Run: node packages/cli/build.cjs
const esbuild = require('esbuild')
const path = require('path')

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    target: ['node18'],
    format: 'cjs',
    outfile: path.join(__dirname, 'dist', 'lexweave.cjs'),
    banner: {js: '#!/usr/bin/env node'},
    alias: {
      '@lexweave/core': path.join(__dirname, '..', 'core', 'src', 'index.ts'),
      '@lexweave/compile': path.join(__dirname, '..', 'compile', 'src', 'index.ts'),
      '@lexweave/render': path.join(__dirname, '..', 'render', 'src', 'index.ts'),
    },
    logLevel: 'info',
  })
  .then(() => {
    const fs = require('fs')
    fs.chmodSync(path.join(__dirname, 'dist', 'lexweave.cjs'), 0o755)
  })
  .catch(() => process.exit(1))
