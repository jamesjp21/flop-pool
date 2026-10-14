// Builds:
//   default:     dist/server/index.mjs (Node server) + dist/web/* (web app using the HTTP API)
//   --artifact:  dist/artifact/flop-pool.html (single-file page with the engine embedded,
//                React loaded from cdnjs as UMD globals; for the private claude.ai preview)

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const artifact = process.argv.includes('--artifact');
const REACT_VERSION = '18.3.1';
const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap';

const common = {
  bundle: true,
  target: 'es2020',
  jsx: 'automatic',
  legalComments: 'none',
  logLevel: 'warning',
};

async function buildServer() {
  await esbuild.build({
    entryPoints: ['src/server/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: 'dist/server/index.mjs',
    sourcemap: true,
    logLevel: 'warning',
  });
}

async function buildWeb() {
  mkdirSync('dist/web', { recursive: true });
  await esbuild.build({
    ...common,
    entryPoints: { app: 'src/web/main.tsx' },
    outdir: 'dist/web',
    format: 'iife',
    minify: true,
    sourcemap: true,
    define: { __BACKEND__: '"http"', 'process.env.NODE_ENV': '"production"' },
  });
  await esbuild.build({ entryPoints: { app: 'src/web/styles.css' }, bundle: true, minify: true, outdir: 'dist/web', logLevel: 'warning' });
  copyFileSync('src/web/index.html', 'dist/web/index.html');
}

// Map react imports to the UMD globals loaded from cdnjs.
const reactGlobals = {
  name: 'react-globals',
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/client|\/jsx-runtime)?$/ }, (a) => ({ path: a.path, namespace: 'react-global' }));
    b.onLoad({ filter: /.*/, namespace: 'react-global' }, (a) => {
      if (a.path === 'react') return { contents: 'module.exports = window.React;', loader: 'js' };
      if (a.path === 'react-dom' || a.path === 'react-dom/client') return { contents: 'module.exports = window.ReactDOM;', loader: 'js' };
      if (a.path === 'react/jsx-runtime') {
        return {
          contents:
            'var R = window.React; function jsx(t, p, k) { return R.createElement(t, k === undefined ? p : Object.assign({}, p, { key: k })); } module.exports = { jsx: jsx, jsxs: jsx, Fragment: R.Fragment };',
          loader: 'js',
        };
      }
      return undefined;
    });
  },
};

async function buildArtifact() {
  mkdirSync('dist/artifact', { recursive: true });
  const js = await esbuild.build({
    ...common,
    entryPoints: ['src/web/main.tsx'],
    format: 'iife',
    minify: true,
    write: false,
    plugins: [reactGlobals],
    define: { __BACKEND__: '"embedded"', 'process.env.NODE_ENV': '"production"' },
  });
  const css = await esbuild.build({ entryPoints: ['src/web/styles.css'], bundle: true, minify: true, write: false, logLevel: 'warning' });
  const jsText = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const cssText = css.outputFiles[0].text.replace(/<\/style/gi, '<\\/style');
  const html = [
    '<title>Flop Pool</title>',
    '<meta name="claude:viewport-fit-sides" content="cover">',
    '<meta name="description" content="Prototype of fixed, fully funded FLOP mining campaigns with simulated funds">',
    `<link rel="stylesheet" href="${FONTS}">`,
    `<style>${cssText}</style>`,
    '<div id="root"><div class="loading">Loading the demo…</div></div>',
    `<script src="https://cdnjs.cloudflare.com/ajax/libs/react/${REACT_VERSION}/umd/react.production.min.js"></script>`,
    `<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/${REACT_VERSION}/umd/react-dom.production.min.js"></script>`,
    `<script>${jsText}</script>`,
  ].join('\n');
  writeFileSync('dist/artifact/flop-pool.html', html);
  // Local test harness: same page wrapped in a full document.
  writeFileSync(
    'dist/artifact/local-test.html',
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${html}</body></html>`,
  );
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`artifact: dist/artifact/flop-pool.html (${kb} KB)`);
}

if (artifact) {
  await buildArtifact();
} else {
  rmSync('dist/server', { recursive: true, force: true });
  rmSync('dist/web', { recursive: true, force: true });
  await buildServer();
  await buildWeb();
  await buildArtifact();
  console.log('built dist/server, dist/web, dist/artifact');
}

