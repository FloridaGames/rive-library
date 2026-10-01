#!/usr/bin/env node
/* Builds the Rive Library into dist/.

     node tools/build.mjs                 build with the public base URL from library.config.json
     node tools/build.mjs --serve         build for http://localhost:8780/ and serve it there
     node tools/build.mjs --serve 9000    same, on another port
     node tools/build.mjs --check         only validate the samples, write nothing

   The only source of truth is samples/<id>/sample.json plus the .riv next to it. Everything else is generated:
   library.json (the index the gallery reads), llms.txt (the entry point for AI tools), and per sample a README.md
   and a runnable example.html. Node only, no npm install. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const core = require(path.join(ROOT, 'assets', 'core.js'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'library.config.json'), 'utf8'));

const args = process.argv.slice(2);
const serve = args.includes('--serve');
const checkOnly = args.includes('--check');
const port = serve ? Number(args[args.indexOf('--serve') + 1]) || 8780 : 0;
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
const base = withSlash(baseArg || (serve ? `http://localhost:${port}/` : config.baseUrl));

function withSlash(u) { return u.endsWith('/') ? u : u + '/'; }

/* ---------- read and validate ---------- */

const TYPES = ['number', 'color', 'boolean', 'string', 'enum', 'trigger'];
const problems = [];
const samples = [];

for (const dir of fs.readdirSync(path.join(ROOT, 'samples')).sort()) {
  const folder = path.join(ROOT, 'samples', dir);
  if (!fs.statSync(folder).isDirectory()) continue;
  const where = `samples/${dir}`;
  const jsonPath = path.join(folder, 'sample.json');
  if (!fs.existsSync(jsonPath)) { problems.push(`${where}: no sample.json`); continue; }
  let s;
  try { s = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch (e) { problems.push(`${where}/sample.json: not valid JSON (${e.message})`); continue; }

  const bad = (msg) => problems.push(`${where}/sample.json: ${msg}`);
  if (s.id !== dir) bad(`"id" must equal the folder name "${dir}"`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id || '')) bad('"id" may only hold lowercase letters, digits and dashes');
  for (const k of ['title', 'summary', 'category', 'file', 'artboard', 'stateMachine']) {
    if (!s[k] || typeof s[k] !== 'string') bad(`"${k}" is missing`);
  }
  for (const k of ['width', 'height']) if (!(s[k] > 0)) bad(`"${k}" must be a positive number (the artboard size)`);
  if (s.file && !fs.existsSync(path.join(folder, s.file))) bad(`"file": ${s.file} is not in the folder`);
  if (s.file && !s.file.endsWith('.riv')) bad('"file" must be a .riv');
  if (s.poster && !fs.existsSync(path.join(folder, s.poster))) bad(`"poster": ${s.poster} is not in the folder`);
  if (s.tags && !Array.isArray(s.tags)) bad('"tags" must be a list');
  const names = new Set();
  for (const c of s.controls || []) {
    if (!c.name) { bad('a control without "name"'); continue; }
    if (names.has(c.name)) bad(`control "${c.name}" appears twice`);
    names.add(c.name);
    if (!TYPES.includes(c.type)) bad(`control "${c.name}": type must be one of ${TYPES.join(', ')}`);
    if (c.type === 'color' && c.default && !/^#[0-9a-f]{6}$/i.test(c.default)) bad(`control "${c.name}": colour default must look like #0e2879`);
    if (c.type === 'number' && c.min !== undefined && c.max !== undefined && c.min > c.max) bad(`control "${c.name}": min is above max`);
    if (c.type === 'enum' && c.values && c.default !== undefined && !c.values.includes(c.default)) bad(`control "${c.name}": default "${c.default}" is not one of its values`);
  }
  if (s.round) {
    const r = s.round, byName = Object.fromEntries((s.controls || []).map((c) => [c.name, c]));
    for (const code of r.order || []) {
      const c = byName[code];
      if (!c) { bad(`"round.order" has "${code}", which is not a control`); continue; }
      for (const v of [r.reset, r.pending, ...Object.keys(r.outcomes || {})]) {
        if (c.values && !c.values.includes(v)) bad(`"round" uses "${v}", which "${code}" does not have`);
      }
    }
    if (!(r.order || []).length) bad('"round.order" is empty');
  }
  for (const [k, v] of Object.entries(s.preset || {})) {
    const c = (s.controls || []).find((x) => x.name === k);
    if (!c) bad(`"preset" sets "${k}", which is not a control`);
    else if (c.type === 'enum' && c.values && !c.values.includes(v)) bad(`"preset" sets "${k}" to "${v}", which is not one of its values`);
  }
  if (s.recipe && !names.has(s.recipe.property)) bad(`"recipe.property" (${s.recipe.property}) is not one of the controls`);
  const triggerNames = new Set((s.controls || []).filter((c) => c.type === 'trigger').map((c) => c.name));
  for (const t of [s.replayTrigger, s.hoverTrigger, ...(s.controls || []).map((c) => c.preview)]) {
    if (t && !triggerNames.has(t)) bad(`"${t}" is used as a trigger but is not a trigger control`);
  }

  const size = s.file && fs.existsSync(path.join(folder, s.file)) ? fs.statSync(path.join(folder, s.file)).size : 0;
  samples.push({ ...s, size });
}

const ids = new Set();
for (const s of samples) { if (ids.has(s.id)) problems.push(`id "${s.id}" is used twice`); ids.add(s.id); }

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.map((p) => '  - ' + p).join('\n') + '\n');
  process.exit(1);
}
console.log(`${samples.length} samples OK`);
if (checkOnly) process.exit(0);

/* ---------- write dist/ ---------- */

const order = Object.keys(core.CATEGORIES);
samples.sort((a, b) =>
  (order.indexOf(a.category) + 1 || 99) - (order.indexOf(b.category) + 1 || 99) || a.title.localeCompare(b.title));

const runtime = config.runtime || core.DEFAULT_RUNTIME;

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const item of ['assets', 'samples']) copy(path.join(ROOT, item), path.join(DIST, item));
for (const page of ['index.html', 'embed.html']) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8').replaceAll('__RIVE_RUNTIME__', core.runtimeUrl(runtime));
  fs.writeFileSync(path.join(DIST, page), html);
}
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
const library = {
  name: config.name,
  description: config.description,
  baseUrl: base,
  repo: config.repo,
  branch: config.branch || 'main',
  runtime,
  generated: new Date().toISOString(),
  samples: samples.map((s) => ({
    ...s,
    path: core.samplePath(s),
    url: core.fileUrl(s, base),
    posterUrl: core.posterUrl(s, base) || undefined,
    readme: core.readmeUrl(s, base),
    example: core.exampleUrl(s, base),
    page: core.pageUrl(s, base),
  })),
};
fs.writeFileSync(path.join(DIST, 'library.json'), JSON.stringify(library, null, 2) + '\n');
fs.writeFileSync(path.join(DIST, 'llms.txt'), core.llms(library, base));
for (const s of samples) {
  const out = path.join(DIST, 'samples', s.id);
  fs.writeFileSync(path.join(out, 'README.md'), core.readme(s, base, runtime));
  fs.writeFileSync(path.join(out, 'example.html'), core.html(s, base, core.initial(s), { runtime, background: s.background }) + '\n');
}
console.log(`dist/ written for ${base}`);

function copy(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) copy(path.join(from, f), path.join(to, f));
  } else fs.copyFileSync(from, to);
}

/* ---------- --serve ---------- */

if (serve) {
  const TYPES_MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.webp': 'image/webp', '.riv': 'application/octet-stream', '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  };
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, base).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(DIST, p);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, {
      'content-type': TYPES_MIME[path.extname(file)] || 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1', () => console.log(`serving ${base}`));
}
