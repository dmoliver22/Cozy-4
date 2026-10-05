// Build a single self-contained HTML fragment for hosts that wrap the page in
// their own <html>/<head>/<body> skeleton and only allow inline scripts and
// styles (e.g. a claude.ai Artifact). Fonts are embedded as data URIs. Such
// sandboxes block plain downloads, so this build saves photos through the
// host's save prompt (window.claude downloads) and hides the button without it.
//
//   npm run build:artifact   ->   dist-artifact/terraces.html
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist-artifact';
execSync(`npx vite build --outDir ${out} --emptyOutDir`, {
  stdio: 'inherit',
  env: { ...process.env, VITE_ARTIFACT: '1' },
});

const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const pick = (re, what) => {
  const m = html.match(re);
  if (!m) throw new Error(`could not find ${what} in the built index.html`);
  return m;
};

const title = pick(/<title>[\s\S]*?<\/title>/, 'title')[0];
const cssHref = pick(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/, 'stylesheet')[1];
const jsSrc = pick(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/, 'module script')[1];

let css = fs.readFileSync(path.join(out, cssHref), 'utf8');
// keep only the woff2 sources, embedded
css = css.replace(/,\s*url\(\.\/[^)]+\.woff\)\s*format\("woff"\)/g, '');
css = css.replace(/url\(\.\/([^)]+\.woff2)\)/g, (_, f) => {
  const b64 = fs.readFileSync(path.join(out, 'assets', f)).toString('base64');
  return `url(data:font/woff2;base64,${b64})`;
});

const js = fs.readFileSync(path.join(out, jsSrc), 'utf8');
if (/<\/script/i.test(js) || js.includes('<!--')) throw new Error('bundle contains a sequence that would break an inline <script>');

let body = pick(/<body>([\s\S]*?)<\/body>/, 'body')[1];
body = body.replace(/<script type="module"[\s\S]*?<\/script>/g, '').trim();

const page = `${title}
<style>${css}</style>
${body}
<script type="module">${js}</script>
`;
const file = path.join(out, 'terraces.html');
fs.writeFileSync(file, page);
console.log(`\n${file}: ${(Buffer.byteLength(page) / 1048576).toFixed(2)} MB`);
