/* Rive Library: the code generator.

   One module, two users: the website (assets/app.js, in the browser) and the build (tools/build.mjs, in Node).
   Everything a visitor copies, and every README and llms.txt the build writes, comes out of this file. That is
   the point: the snippet on the page and the README an AI tool reads can never disagree.

   No dependencies and no DOM. Every function takes the sample (as in sample.json), the base URL the library is
   served from, and the current control values. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RiveLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_RUNTIME = '2.42.1';

  /* ---------- small helpers ---------- */

  function runtimeUrl(version) {
    return 'https://cdn.jsdelivr.net/npm/@rive-app/canvas@' + (version || DEFAULT_RUNTIME) + '/rive.js';
  }

  function samplePath(s) { return 'samples/' + s.id + '/'; }
  function fileUrl(s, base) { return base + samplePath(s) + s.file; }
  function posterUrl(s, base) { return s.poster ? base + samplePath(s) + s.poster : ''; }
  function readmeUrl(s, base) { return base + samplePath(s) + 'README.md'; }
  function exampleUrl(s, base) { return base + samplePath(s) + 'example.html'; }
  function pageUrl(s, base) { return base + '#/s/' + s.id; }

  /* 'icon-shield-check' -> 'iconShieldCheck': a variable name per sample, so two snippets on one page don't clash. */
  function varName(id) {
    var v = String(id).replace(/[^a-zA-Z0-9]+(.)?/g, function (_, c) { return c ? c.toUpperCase() : ''; });
    if (!/^[a-zA-Z_$]/.test(v)) v = 'r' + v;
    return v;
  }
  function componentName(id) { var v = varName(id); return v.charAt(0).toUpperCase() + v.slice(1); }

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 0, 0];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function round(n) { return Math.round(n * 1000) / 1000; }
  function q(s) { return JSON.stringify(String(s)); }            /* a JS string literal, double quotes */
  function esc(s) {                                                /* for HTML attributes and text */
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pad(lines) {                                            /* align trailing // comments */
    var w = 0;
    lines.forEach(function (l) { if (l[1]) w = Math.max(w, l[0].length); });
    return lines.map(function (l) { return l[1] ? l[0] + new Array(w - l[0].length + 2).join(' ') + '// ' + l[1] : l[0]; });
  }
  function indent(lines, n) {
    var sp = new Array(n + 1).join(' ');
    return lines.map(function (l) { return l ? sp + l : l; });
  }

  /* ---------- controls ---------- */

  function controls(s) { return s.controls || []; }
  function isInput(c) { return c.source === 'input'; }
  function settable(s) {                                           /* what a snippet sets in onLoad */
    var anim = s.recipe && s.recipe.property;
    return controls(s).filter(function (c) {
      return c.type !== 'trigger' && !c.internal && c.name !== anim && ['number', 'color', 'boolean', 'string', 'enum'].indexOf(c.type) >= 0;
    });
  }
  function triggers(s) { return controls(s).filter(function (c) { return c.type === 'trigger' && !c.internal; }); }
  function hasViewModel(s) { return controls(s).some(function (c) { return !isInput(c); }); }
  function hasInputs(s) { return controls(s).some(isInput); }

  function defaults(s) {
    var v = {};
    controls(s).forEach(function (c) { if (c.type !== 'trigger' && c.default !== undefined) v[c.name] = c.default; });
    return v;
  }
  function valueOf(c, values) {
    return values && values[c.name] !== undefined ? values[c.name] : c.default;
  }
  function label(c) {
    return (c.label || c.name) + (c.unit ? ' (' + c.unit + ')' : '');
  }

  /* One line that sets a control. `r` is the Rive variable, `ts` adds TypeScript's non-null `!`. */
  function setLine(c, v, ts) {
    var bang = ts ? '!' : '';
    if (isInput(c)) {
      var inp = 'input(' + q(c.name) + ')' + bang;
      if (c.type === 'boolean') return inp + '.value = ' + (v ? 'true' : 'false') + ';';
      return inp + '.value = ' + round(Number(v) || 0) + ';';
    }
    if (c.type === 'color') {
      var rgb = hexToRgb(v);
      return 'vm.color(' + q(c.name) + ')' + bang + '.rgb(' + rgb.join(', ') + ');';
    }
    var kind = c.type === 'enum' ? 'enum' : c.type;
    var val = c.type === 'number' ? String(round(Number(v) || 0))
      : c.type === 'boolean' ? (v ? 'true' : 'false') : q(v == null ? '' : v);
    return 'vm.' + kind + '(' + q(c.name) + ')' + bang + '.value = ' + val + ';';
  }
  function setComment(c, v) {
    return label(c) + (c.type === 'color' ? ': ' + String(v).toLowerCase() : '');
  }
  /* Firing a trigger. Plain JS runs after onLoad, so it can be direct; React reads `rive` from state, so every step
     may be null and gets a `?.`. */
  function fireLine(c, s, rv, react) {
    var o = react ? '?.' : '.';
    if (isInput(c)) {
      return rv + o + 'stateMachineInputs(' + q(s.stateMachine) + ')?.find((i) => i.name === ' + q(c.name) + ')' + o + 'fire();';
    }
    return rv + o + 'viewModelInstance' + o + 'trigger(' + q(c.name) + ')' + o + 'trigger();';
  }

  /* ---------- recipes: behaviour the file leaves to the page ---------- */

  function drawOnJs(fn) {
    return [
      '// The icon has no timeline of its own: this animates a 0..1 property with an ease-out.',
      'function ' + fn + '(r, property, ms) {',
      '  const progress = r.viewModelInstance.number(property);',
      '  const start = performance.now();',
      '  progress.value = 0;',
      '  requestAnimationFrame(function step(now) {',
      '    const t = Math.min(1, (now - start) / ms);',
      '    progress.value = 1 - Math.pow(1 - t, 3);',
      '    if (t < 1) requestAnimationFrame(step);',
      '  });',
      '}',
    ];
  }
  function drawOnTs() {
    return [
      '// The icon has no timeline of its own: this animates a 0..1 property with an ease-out.',
      'function drawOn(rive: Rive, property: string, ms: number) {',
      '  const progress = rive.viewModelInstance?.number(property);',
      '  if (!progress) return;',
      '  const start = performance.now();',
      '  progress.value = 0;',
      '  const step = (now: number) => {',
      '    const t = Math.min(1, (now - start) / ms);',
      '    progress.value = 1 - Math.pow(1 - t, 3);',
      '    if (t < 1) requestAnimationFrame(step);',
      '  };',
      '  requestAnimationFrame(step);',
      '}',
    ];
  }
  function recipeDuration(s, o) {
    return (o && o.duration) || (s.recipe && s.recipe.duration) || 700;
  }

  /* ---------- plain HTML ---------- */

  function html(s, base, values, o) {
    o = o || {};
    var rv = varName(s.id), width = Math.round(o.width || s.displayWidth || s.width);
    var recipe = s.recipe && s.recipe.type === 'draw-on' ? s.recipe : null;
    var ms = recipeDuration(s, o);
    var sets = settable(s);
    var load = [rv + '.resizeDrawingSurfaceToCanvas();'];
    if (sets.length && hasViewModel(s)) load.push('const vm = ' + rv + '.viewModelInstance;');
    if (hasInputs(s)) load.push('const input = (name) => ' + rv + '.stateMachineInputs(' + q(s.stateMachine) + ')?.find((i) => i.name === name);');
    var setters = sets.map(function (c) { var v = valueOf(c, values); return [setLine(c, v, false), setComment(c, v)]; });
    load = load.concat(pad(setters));
    if (recipe) load.push('riveDrawOn(' + rv + ', ' + q(recipe.property) + ', ' + ms + ');');

    var js = [];
    js.push('const ' + rv + ' = new rive.Rive({');
    js.push('  src: ' + q(fileUrl(s, base)) + ',');
    js.push('  canvas: document.getElementById(' + q(s.id) + '),');
    js.push('  artboard: ' + q(s.artboard) + ',');
    js.push('  stateMachine: ' + q(s.stateMachine) + ',');
    js.push('  autoplay: true,');
    js.push('  autoBind: true, // connects the view model, so the values below take effect');
    js.push('  onLoad: () => {');
    js = js.concat(indent(load, 4));
    js.push('  },');
    js.push('});');
    js.push('// Keep it sharp when the page or the canvas changes size.');
    js.push('window.addEventListener("resize", () => ' + rv + '.resizeDrawingSurfaceToCanvas());');
    if (recipe) {
      js.push('// Draw it again on click.');
      js.push('document.getElementById(' + q(s.id) + ').addEventListener("click", () => riveDrawOn(' + rv + ', ' + q(recipe.property) + ', ' + ms + '));');
      js.push('');
      js = js.concat(drawOnJs('riveDrawOn'));
    }
    var trig = triggers(s);
    if (trig.length) {
      js.push('');
      js.push('// Triggers: call these whenever you like (after onLoad).');
      js = js.concat(pad(trig.map(function (c) { return ['// ' + fireLine(c, s, rv, false), c.label || '']; })));
    }

    var out = [];
    out.push('<!doctype html>');
    out.push('<html lang="en">');
    out.push('<head>');
    out.push('  <meta charset="utf-8">');
    out.push('  <meta name="viewport" content="width=device-width, initial-scale=1">');
    out.push('  <title>' + esc(s.title) + ' · Rive</title>');
    out.push('</head>');
    out.push('<body' + (o.background ? ' style="background: ' + esc(o.background) + ';"' : '') + '>');
    out.push('  <!-- ' + esc(s.title) + ' · from the Rive Library: ' + pageUrl(s, base));
    out.push('       To use it in your own page, copy the <canvas> and both <script> tags.');
    out.push('       Load rive.js only once per page, however many animations you add. -->');
    out.push('  <canvas id="' + esc(s.id) + '" style="display: block; width: ' + width + 'px; max-width: 100%; aspect-ratio: ' + s.width + ' / ' + s.height + ';' + (recipe ? ' cursor: pointer;' : '') + '"></canvas>');
    out.push('');
    out.push('  <script src="' + runtimeUrl(o.runtime) + '"></script>');
    out.push('  <script>');
    out = out.concat(indent(js, 4));
    out.push('  </script>');
    out.push('</body>');
    out.push('</html>');
    return out.join('\n');
  }

  /* ---------- React (Lovable, Next.js, Vite): TSX ---------- */

  function react(s, base, values, o) {
    o = o || {};
    var name = componentName(s.id), width = Math.round(o.width || s.displayWidth || s.width);
    var recipe = s.recipe && s.recipe.type === 'draw-on' ? s.recipe : null;
    var ms = recipeDuration(s, o);
    var sets = settable(s);
    var trig = triggers(s);

    var out = [];
    out.push('// ' + s.title + ' · from the Rive Library: ' + pageUrl(s, base));
    out.push('// npm install @rive-app/react-canvas');
    out.push('import { useEffect } from "react";');
    out.push('import { useRive' + (recipe ? ', type Rive' : '') + ' } from "@rive-app/react-canvas";');
    out.push('');
    out.push('const SRC = ' + q(fileUrl(s, base)) + ';');
    out.push('');
    out.push('export function ' + name + '({ width = ' + width + ' }: { width?: number }) {');
    out.push('  const { rive, RiveComponent } = useRive({');
    out.push('    src: SRC,');
    out.push('    artboard: ' + q(s.artboard) + ',');
    out.push('    stateMachine: ' + q(s.stateMachine) + ',');
    out.push('    autoplay: true,');
    out.push('    autoBind: true, // connects the view model, so the values below take effect');
    out.push('  });');
    out.push('');
    out.push('  // `rive` is null until the file has loaded; then set the values once.');
    out.push('  useEffect(() => {');
    out.push('    if (!rive) return;');
    if (sets.length && hasViewModel(s)) {
      out.push('    const vm = rive.viewModelInstance;');
      out.push('    if (!vm) return;');
    }
    if (hasInputs(s)) out.push('    const input = (name: string) => rive.stateMachineInputs(' + q(s.stateMachine) + ')?.find((i) => i.name === name);');
    out = out.concat(indent(pad(sets.map(function (c) { var v = valueOf(c, values); return [setLine(c, v, true), setComment(c, v)]; })), 4));
    if (recipe) out.push('    drawOn(rive, ' + q(recipe.property) + ', ' + ms + ');');
    out.push('  }, [rive]);');
    if (trig.length) {
      out.push('');
      out.push('  // Triggers: call these from any event handler.');
      out = out.concat(indent(pad(trig.map(function (c) { return ['// ' + fireLine(c, s, 'rive', true), c.label || '']; })), 2));
    }
    out.push('');
    out.push('  return (');
    out.push('    <div');
    if (recipe) out.push('      onClick={() => rive && drawOn(rive, ' + q(recipe.property) + ', ' + ms + ')}');
    out.push('      style={{ width, maxWidth: "100%", aspectRatio: "' + s.width + ' / ' + s.height + '"' + (recipe ? ', cursor: "pointer"' : '') + ' }}');
    out.push('    >');
    out.push('      <RiveComponent />');
    out.push('    </div>');
    out.push('  );');
    out.push('}');
    if (recipe) { out.push(''); out = out.concat(drawOnTs()); }
    return out.join('\n');
  }

  /* ---------- iframe embed (Canvas LMS, Moodle, Notion, Google Sites, ...) ---------- */

  function embedSrc(s, base, values, o) {
    o = o || {};
    var p = ['id=' + encodeURIComponent(s.id)];
    settable(s).forEach(function (c) {
      var v = valueOf(c, values);
      if (v === undefined || String(v) === String(c.default)) return;
      if (c.type === 'color') v = String(v).replace('#', '');
      if (c.type === 'number') v = round(Number(v));
      p.push(encodeURIComponent(c.name) + '=' + encodeURIComponent(v));
    });
    if (o.background && o.background !== 'transparent') p.push('bg=' + encodeURIComponent(String(o.background).replace('#', '')));
    if (o.every) p.push('every=' + encodeURIComponent(o.every));
    return base + 'embed.html?' + p.join('&');
  }

  function embed(s, base, values, o) {
    o = o || {};
    var width = Math.round(o.width || s.displayWidth || s.width);
    var height = Math.round(width * s.height / s.width);
    return '<iframe src="' + esc(embedSrc(s, base, values, o)) + '"\n' +
      '        title="' + esc(s.title) + ' (animation)" width="' + width + '" height="' + height + '" loading="lazy"\n' +
      '        style="border: 0; max-width: 100%; height: auto; aspect-ratio: ' + s.width + ' / ' + s.height + ';"></iframe>';
  }

  /* ---------- documentation: the prompt, the README, llms.txt ---------- */

  function controlTable(s, values) {
    var rows = controls(s).filter(function (c) { return !c.internal; });
    if (!rows.length) return [];
    var anim = s.recipe && s.recipe.property;
    var out = ['| Name | Type | ' + (values ? 'Value' : 'Default') + ' | What it does |', '|---|---|---|---|'];
    rows.forEach(function (c) {
      var v = c.type === 'trigger' ? '—' : valueOf(c, values);
      if (c.type === 'number' && v !== '—') {
        v = round(Number(v));
        if (c.min !== undefined && c.max !== undefined) v += ' (' + c.min + '–' + c.max + (c.unit ? ' ' + c.unit : '') + ')';
      }
      var kind = c.type + (isInput(c) ? ' input' : '');
      var what = (c.description || c.label || '').replace(/\|/g, '\\|');
      if (c.name === anim) what += ' Animated by the code, not set once.';
      out.push('| `' + c.name + '` | ' + kind + ' | ' + v + ' | ' + what + ' |');
    });
    return out;
  }

  function rules(s) {
    var r = [];
    r.push('- Load the file as it is. Do not redraw the artwork in SVG/CSS and do not edit the .riv: change it only through the controls above.');
    r.push('- Pass `stateMachine: "' + s.stateMachine + '"` and `autoplay: true`' + (hasViewModel(s) ? ', plus `autoBind: true`' : '') + '. Without the state machine nothing moves' + (hasViewModel(s) ? ', and without autoBind `viewModelInstance` stays null and the controls do nothing' : '') + '. (Older examples use `stateMachines`; current runtimes warn that it is deprecated.)');
    r.push('- Set values only after loading: in `onLoad` (plain JS) or once `rive` is non-null (React).');
    r.push('- Size the canvas with CSS and keep the aspect ratio ' + s.width + ' / ' + s.height + '; call `resizeDrawingSurfaceToCanvas()` after load and on resize so it stays sharp on high-DPI screens.');
    r.push('- Load the runtime once per page, however many animations there are.');
    return r;
  }

  function prompt(s, base, values, o) {
    o = o || {};
    var stack = o.stack === 'react' ? 'react' : 'html';
    var out = [];
    out.push('# Add a Rive animation: ' + s.title);
    out.push('');
    out.push('Add this ready-made Rive animation to my project. ' + (s.summary || ''));
    out.push('');
    out.push('## File');
    out.push('- **.riv file:** ' + fileUrl(s, base) + ' (public and CORS-enabled: load it straight from this URL, or download it into the project\'s public/static folder)');
    out.push('- **Artboard:** `' + s.artboard + '` · **State machine:** `' + s.stateMachine + '` · **Size:** ' + s.width + ' × ' + s.height + ' (keep this aspect ratio), shown about ' + Math.round(o.width || s.displayWidth || s.width) + ' px wide');
    out.push('- **Runtime:** ' + (stack === 'react' ? '`@rive-app/react-canvas` (npm)' : '`' + runtimeUrl(o.runtime) + '` (script tag, global `rive`), or `@rive-app/canvas` from npm'));
    out.push('- **Full documentation:** ' + readmeUrl(s, base));
    if (s.description) { out.push(''); out.push('## What it does'); out.push(s.description); }
    if (s.notes && s.notes.length) { out.push(''); s.notes.forEach(function (n) { out.push('- ' + n); }); }
    var t = controlTable(s, values);
    if (t.length) {
      out.push('');
      out.push('## Controls' + (hasViewModel(s) ? ' (view model, via `viewModelInstance`)' : ''));
      out = out.concat(t);
    }
    out.push('');
    out.push('## Rules');
    out = out.concat(rules(s));
    out.push('');
    out.push('## Working example (' + (stack === 'react' ? 'React + TypeScript' : 'plain HTML') + ')');
    out.push('Adapt this to the project; the values are the ones I picked.');
    out.push('');
    out.push(stack === 'react' ? '```tsx' : '```html');
    out.push(stack === 'react' ? react(s, base, values, o) : html(s, base, values, o));
    out.push('```');
    if (s.license) { out.push(''); out.push('License / use: ' + s.license); }
    return out.join('\n');
  }

  function readme(s, base, runtime) {
    var o = { runtime: runtime };
    var out = [];
    out.push('# ' + s.title);
    out.push('');
    out.push('> ' + (s.summary || ''));
    out.push('');
    out.push('Part of the Rive Library: ' + pageUrl(s, base) + ' (live preview, controls and copy buttons).');
    out.push('');
    out.push('| | |');
    out.push('|---|---|');
    out.push('| File | ' + fileUrl(s, base) + ' |');
    if (s.poster) out.push('| Static fallback | ' + posterUrl(s, base) + ' |');
    out.push('| Artboard | `' + s.artboard + '` |');
    out.push('| State machine | `' + s.stateMachine + '` |');
    out.push('| Size | ' + s.width + ' × ' + s.height + ' |');
    out.push('| Runtime | `@rive-app/canvas` ' + (runtime || DEFAULT_RUNTIME) + ' (tested) · `@rive-app/react-canvas` |');
    if (s.author) out.push('| Made by | ' + s.author + ' |');
    if (s.source) out.push('| Source | ' + s.source + ' |');
    if (s.license) out.push('| License / use | ' + s.license + ' |');
    if (s.description) { out.push(''); out.push('## What it does'); out.push(''); out.push(s.description); }
    if (s.notes && s.notes.length) { out.push(''); s.notes.forEach(function (n) { out.push('- ' + n); }); }
    var t = controlTable(s, null);
    if (t.length) { out.push(''); out.push('## Controls'); out.push(''); out = out.concat(t); }
    var internal = controls(s).filter(function (c) { return c.internal; });
    if (internal.length) {
      out.push('');
      internal.forEach(function (c) { out.push('Also in the file: `' + c.name + '` (' + c.type + '). ' + (c.description || '')); });
    }
    out.push('');
    out.push('## Rules');
    out.push('');
    out = out.concat(rules(s));
    out.push('');
    out.push('## Plain HTML');
    out.push('');
    out.push('Also as a ready-to-open page: ' + exampleUrl(s, base));
    out.push('');
    out.push('```html');
    out.push(html(s, base, null, o));
    out.push('```');
    out.push('');
    out.push('## React (TypeScript)');
    out.push('');
    out.push('```tsx');
    out.push(react(s, base, null, o));
    out.push('```');
    out.push('');
    out.push('## Where scripts are not allowed (Canvas LMS, Moodle, Notion, Google Sites)');
    out.push('');
    out.push('```html');
    out.push(embed(s, base, null, o));
    out.push('```');
    out.push('');
    out.push('Any control can go in the URL (`&' + (settable(s)[0] ? settable(s)[0].name : 'name') + '=...`, colours without `#`), plus `bg=ffffff` for a background and `every=30` to replay every 30 seconds.');
    return out.join('\n') + '\n';
  }

  function llms(lib, base) {
    var out = [];
    out.push('# ' + (lib.name || 'Rive Library'));
    out.push('');
    out.push('> Ready-made Rive animations (logos, icons, interface pieces) with working code for plain HTML and React. Every file is public and CORS-enabled, so a page can load it straight from the URLs below.');
    out.push('');
    out.push('How to use any sample: open its README (linked below). It gives the exact artboard, state machine and controls, plus a complete HTML and React example. In short:');
    out.push('');
    out.push('- Runtime: `<script src="' + runtimeUrl(lib.runtime) + '"></script>` (global `rive`), or npm `@rive-app/canvas` / `@rive-app/react-canvas`.');
    out.push('- `new rive.Rive({ src, canvas, artboard, stateMachine, autoplay: true, autoBind: true, onLoad })`.');
    out.push('- Change it through `r.viewModelInstance`: `.number(name).value`, `.color(name).rgb(r, g, b)`, `.boolean(name).value`, `.trigger(name).trigger()`.');
    out.push('- Never redraw the artwork yourself; load the .riv.');
    var groups = {};
    (lib.samples || []).forEach(function (s) { (groups[s.category] = groups[s.category] || []).push(s); });
    Object.keys(groups).forEach(function (cat) {
      out.push('');
      out.push('## ' + categoryLabel(cat));
      out.push('');
      groups[cat].forEach(function (s) { out.push('- [' + s.title + '](' + readmeUrl(s, base) + '): ' + (s.summary || '')); });
    });
    out.push('');
    out.push('## Optional');
    out.push('');
    out.push('- [library.json](' + base + 'library.json): every sample with its controls and file URLs, machine-readable');
    out.push('- [Gallery](' + base + '): live previews and copy buttons');
    return out.join('\n') + '\n';
  }

  var CATEGORIES = {
    logo: 'Logos', icon: 'Icons', character: 'Characters', interface: 'Interface', illustration: 'Illustrations',
    background: 'Backgrounds', other: 'Other',
  };
  function categoryLabel(c) { return CATEGORIES[c] || (c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Other'); }

  return {
    DEFAULT_RUNTIME: DEFAULT_RUNTIME,
    CATEGORIES: CATEGORIES,
    categoryLabel: categoryLabel,
    runtimeUrl: runtimeUrl,
    samplePath: samplePath,
    fileUrl: fileUrl,
    posterUrl: posterUrl,
    readmeUrl: readmeUrl,
    exampleUrl: exampleUrl,
    pageUrl: pageUrl,
    varName: varName,
    hexToRgb: hexToRgb,
    defaults: defaults,
    settable: settable,
    triggers: triggers,
    html: html,
    react: react,
    embed: embed,
    embedSrc: embedSrc,
    prompt: prompt,
    readme: readme,
    llms: llms,
  };
});
