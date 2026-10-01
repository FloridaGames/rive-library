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
  /* What a page starts with: the defaults, with the sample's `preset` on top. The council vote is all `none` by
     default, which shows nothing; its preset is a vote in progress. */
  function initial(s) {
    var v = defaults(s);
    Object.keys(s.preset || {}).forEach(function (k) { v[k] = s.preset[k]; });
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

  /* The lines onLoad uses to set values. Up to eight controls: every one, so the snippet doubles as the list of what
     can be set. More than that (the council vote has 25): only those that differ from the default, plus one example
     line. The README and the AI prompt still list every control in their table. */
  var MANY = 8;
  function exampleValue(c) {
    if (c.type === 'enum' && c.values && c.values.length > 1) return c.values[1];
    if (c.type === 'boolean') return !c.default;
    if (c.type === 'number') return c.max !== undefined ? c.max : 1;
    return c.default;
  }
  function setters(s, values, ts) {
    var all = settable(s);
    var list = all.length <= MANY ? all : all.filter(function (c) { return String(valueOf(c, values)) !== String(c.default); });
    var lines = pad(list.map(function (c) { var v = valueOf(c, values); return [setLine(c, v, ts), setComment(c, v)]; }));
    var rest = all.filter(function (c) { return list.indexOf(c) < 0; });
    if (all.length > MANY && rest.length) {
      lines.push('// ' + rest.length + ' more at their default (' + rest.slice(0, 6).map(function (c) { return c.name; }).join(', ') +
        (rest.length > 6 ? ', ...' : '') + '), e.g. ' + setLine(rest[0], exampleValue(rest[0]), ts));
    }
    return lines;
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

  /* ---------- a vote round (samples with "round" in sample.json) ---------- */

  /* The same round the library page plays, as code to copy: everyone back to the reset value, then member by member
     in `round.order`: first the pending value (the voting moment), after `think` ms the vote, drawn at random. */
  function roundPick(round) {
    var keys = Object.keys(round.outcomes), total = 0, acc = 0;
    keys.forEach(function (k) { total += round.outcomes[k]; });
    var parts = keys.slice(0, -1).map(function (k) { acc += round.outcomes[k]; return 'x < ' + round3(acc / total) + ' ? ' + q(k) + ' : '; });
    return '() => { const x = Math.random(); return ' + parts.join('') + q(keys[keys.length - 1]) + '; }';
  }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function roundOrder(round) {
    var lines = [], o = round.order;
    for (var i = 0; i < o.length; i += 14) lines.push('  ' + o.slice(i, i + 14).map(q).join(', ') + ',');
    return lines;
  }
  function roundJs(s, vmExpr, ts) {
    var r = s.round, bang = ts ? '!' : '';
    var step = (r.think || 800) + (r.pause || 200), start = r.start || 700;
    var lines = [];
    lines.push('const VOTE_ORDER = [');
    lines = lines.concat(roundOrder(r));
    lines.push('];');
    lines.push('const pickVote = ' + roundPick(r) + ';');
    return lines.concat([
      (ts ? 'const holdVote = () => {' : 'function holdVote() {'),
      '  const vm = ' + vmExpr + ';',
      '  if (!vm) return;',
      '  VOTE_ORDER.forEach((c) => { vm.enum(c)' + bang + '.value = ' + q(r.reset) + '; });',
      '  VOTE_ORDER.forEach((c, i) => {',
      '    const at = ' + start + ' + i * ' + step + ';',
      '    setTimeout(() => { vm.enum(c)' + bang + '.value = ' + q(r.pending) + '; }, at);',
      '    setTimeout(() => { vm.enum(c)' + bang + '.value = pickVote(); }, at + ' + (r.think || 800) + ');',
      '  });',
      (ts ? '};' : '}'),
    ]);
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
    load = load.concat(setters(s, values, false));
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
    if (s.round) {
      js.push('');
      js.push('// A vote round, like the real thing: everyone back to ' + q(s.round.reset) + ', then member by member');
      js.push('// (' + s.round.order.slice(0, 3).join(', ') + ' ... in order): first ' + q(s.round.pending) + ', then the vote.');
      js = js.concat(roundJs(s, rv + '.viewModelInstance', false));
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
    if (s.round) out.push('  <p><button type="button" onclick="holdVote()">' + esc(s.round.label || 'Hold a vote') + '</button></p>');
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
    out = out.concat(indent(setters(s, values, true), 4));
    if (recipe) out.push('    drawOn(rive, ' + q(recipe.property) + ', ' + ms + ');');
    out.push('  }, [rive]);');
    if (trig.length) {
      out.push('');
      out.push('  // Triggers: call these from any event handler.');
      out = out.concat(indent(pad(trig.map(function (c) { return ['// ' + fireLine(c, s, 'rive', true), c.label || '']; })), 2));
    }
    if (s.round) {
      out.push('');
      out.push('  // A vote round, like the real thing: everyone back to ' + q(s.round.reset) + ', then member by member: first ' + q(s.round.pending) + ', then the vote.');
      out = out.concat(indent(roundJs(s, 'rive?.viewModelInstance', true), 2));
    }
    out.push('');
    out.push('  return (');
    if (s.round) out.push('    <>', '      <button type="button" onClick={holdVote}>' + esc(s.round.label || 'Hold a vote') + '</button>');
    var ind = s.round ? '  ' : '';
    out.push(ind + '    <div');
    if (recipe) out.push(ind + '      onClick={() => rive && drawOn(rive, ' + q(recipe.property) + ', ' + ms + ')}');
    out.push(ind + '      style={{ width, maxWidth: "100%", aspectRatio: "' + s.width + ' / ' + s.height + '"' + (recipe ? ', cursor: "pointer"' : '') + ' }}');
    out.push(ind + '    >');
    out.push(ind + '      <RiveComponent />');
    out.push(ind + '    </div>');
    if (s.round) out.push('    </>');
    out.push('  );');
    out.push('}');
    if (recipe) { out.push(''); out = out.concat(drawOnTs()); }
    return out.join('\n');
  }

  /* ---------- the complete vote round: one standalone page (samples with "round") ---------- */

  function voteDemoUrl(s, base) { return base + samplePath(s) + 'vote-demo.html'; }

  /* Everything the library page does with a vote round, as one file to open or to build on: the animation, a vote
     button (stop, vote again, speed), a running tally, buttons per member, and the outcome under the double majority
     with the population figures. Plain HTML, CSS and JS, no build step. */
  function voteDemo(s, base, o) {
    o = o || {};
    var r = s.round, labels = {};
    controls(s).forEach(function (c) { labels[c.name] = c.label || c.name; });
    var first = controls(s).filter(function (c) { return c.name === r.order[0]; })[0] || {};
    var values = first.values || [r.reset, r.pending].concat(Object.keys(r.outcomes));
    var outs = Object.keys(r.outcomes);
    var known = { yes: 1, no: 1, abstain: 1 };
    function colour(v) { return known[v] ? 'var(--' + v + ')' : 'var(--navy)'; }
    var members = r.order.map(function (c) {
      return '  [' + q(c) + ', ' + q(labels[c] || c) + (r.population ? ', ' + (r.population[c] || 0) : '') + '],';
    });
    var L = [];
    L.push('<!doctype html>');
    L.push('<html lang="en">');
    L.push('<head>');
    L.push('<meta charset="utf-8">');
    L.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
    L.push('<title>' + esc(s.title) + ' · vote round</title>');
    L.push('<!-- ' + esc(s.title) + ': the complete vote round, from the Rive Library: ' + pageUrl(s, base));
    L.push('     One file, no build step: open it in a browser, or use it as the starting point in a project.');
    L.push('     In it: the Rive animation, a vote button (stop, vote again, speed), a running tally, buttons per member to set');
    L.push('     a vote by hand, and the outcome' + (r.population ? ' under qualified majority' : '') + '. The data block at the top of the script is all');
    L.push('     there is to change: members, odds, timing' + (r.population ? ', population and the majority rule' : '') + '. -->');
    L.push('<style>');
    L.push('  :root { --ink: #161922; --muted: #5b6070; --line: #e1ded5; --bg: #f5f4ef; --card: #fff; --navy: #0e2879;');
    L.push('          --yes: #2e9e5b; --no: #d7263d; --abstain: #f0a21f; }');
    L.push('  * { box-sizing: border-box; }');
    L.push('  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); }');
    L.push('  header { max-width: 1180px; margin: 0 auto; padding: 22px 16px 0; }');
    L.push('  h1 { font-size: 24px; margin: 0; }');
    L.push('  header p { margin: 4px 0 0; color: var(--muted); }');
    L.push('  main { max-width: 1180px; margin: 0 auto; padding: 16px 16px 40px; display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, 1fr); gap: 20px; align-items: start; }');
    L.push('  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }');
    L.push('  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 12px 14px; border-bottom: 1px solid var(--line); }');
    L.push('  button { font: inherit; cursor: pointer; }');
    L.push('  #go { font-weight: 600; padding: 11px 18px; border: 0; border-radius: 10px; background: var(--navy); color: #fff; }');
    L.push('  #go.running { background: #eceae3; color: var(--ink); }');
    L.push('  .tally { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; color: var(--muted); }');
    L.push('  .tally b { font-size: 18px; color: var(--ink); font-variant-numeric: tabular-nums; }');
    L.push('  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }');
    L.push('  #status { font-weight: 600; color: var(--ink); }');
    L.push('  .speed { margin-left: auto; color: var(--muted); font-size: 14px; }');
    L.push('  #result { margin: 0; padding: 11px 14px; border-bottom: 1px solid var(--line); }');
    L.push('  #result.adopted { background: #e3f3e9; }');
    L.push('  #result.rejected { background: #fbe5e8; }');
    L.push('  canvas { display: block; width: 100%; aspect-ratio: ' + s.width + ' / ' + s.height + '; }');
    L.push('  .members { padding: 6px 14px 10px; }');
    L.push('  .member { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--line); }');
    L.push('  .member:last-child { border-bottom: 0; }');
    L.push('  .member code { color: var(--muted); font-size: 12px; }');
    L.push('  .seg { display: inline-flex; gap: 2px; padding: 3px; background: #efede6; border-radius: 9px; }');
    L.push('  .seg button { font-size: 12px; font-weight: 600; border: 0; background: transparent; color: var(--muted); padding: 6px 7px; border-radius: 6px; }');
    L.push('  .seg button[aria-pressed="true"] { background: #fff; color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, .12); }');
    outs.concat([r.pending]).forEach(function (v) {
      L.push('  .seg [data-v="' + v + '"][aria-pressed="true"] { background: ' + colour(v) + '; color: #fff; }');
    });
    L.push('  #clear { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }');
    L.push('  @media (max-width: 860px) { main { grid-template-columns: minmax(0, 1fr); } }');
    L.push('</style>');
    L.push('</head>');
    L.push('<body>');
    L.push('<header><h1>' + esc(s.title) + '</h1><p>' + esc(s.summary || '') + '</p></header>');
    L.push('<main>');
    L.push('  <section class="card">');
    L.push('    <div class="bar">');
    L.push('      <button id="go" type="button">▶ ' + esc(r.label || 'Hold a vote') + '</button>');
    L.push('      <div class="tally">');
    outs.forEach(function (v) {
      L.push('        <span><span class="dot" style="background: ' + colour(v) + '"></span><b id="n-' + v + '">0</b> ' + v + '</span>');
    });
    L.push('        <span id="status"></span>');
    L.push('      </div>');
    L.push('      <label class="speed">Speed <select id="speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label>');
    L.push('    </div>');
    L.push('    <p id="result" hidden></p>');
    L.push('    <canvas id="council"></canvas>');
    L.push('  </section>');
    L.push('  <section class="card">');
    L.push('    <div class="bar"><strong>Members</strong><span style="flex: 1"></span><button id="clear" type="button">All to ' + esc(r.reset) + '</button></div>');
    L.push('    <div class="members" id="members"></div>');
    L.push('  </section>');
    L.push('</main>');
    L.push('');
    L.push('<script src="' + runtimeUrl(o.runtime) + '"></script>');
    L.push('<script>');
    L.push('// ---------- the data: change these, the rest follows ----------');
    L.push('const SRC = ' + q(fileUrl(s, base)) + ';');
    L.push('// code, name' + (r.population ? ', population in millions (' + (r.populationNote || 'approximate') + ')' : '') + '. The order is the voting order.');
    L.push('const MEMBERS = [');
    L = L.concat(members);
    L.push('];');
    L.push('const VALUES = ' + JSON.stringify(values) + ';');
    L.push('const RESET = ' + q(r.reset) + ', VOTING = ' + q(r.pending) + ';');
    L.push('const OUTCOMES = ' + JSON.stringify(r.outcomes) + '; // the odds when the round draws a vote');
    L.push('const TIMING = { start: ' + (r.start || 700) + ', think: ' + (r.think || 800) + ', pause: ' + (r.pause || 200) + ' }; // ms at speed 1x');
    if (r.population) {
      var m = r.majority || { states: 0.55, population: 0.65, blocking: 4 };
      L.push('// Qualified majority: at least `states` of the members vote yes, holding at least `population` of the people.');
      L.push('// A blocking minority needs at least `blocking` members. Abstaining counts as not voting yes.');
      L.push('const MAJORITY = { states: ' + m.states + ', population: ' + m.population + ', blocking: ' + m.blocking + ' };');
    }
    L.push('');
    L.push('// ---------- the animation ----------');
    L.push('const council = new rive.Rive({');
    L.push('  src: SRC,');
    L.push('  canvas: document.getElementById("council"),');
    L.push('  artboard: ' + q(s.artboard) + ',');
    L.push('  stateMachine: ' + q(s.stateMachine) + ',');
    L.push('  autoplay: true,');
    L.push('  autoBind: true,');
    L.push('  onLoad: () => {');
    L.push('    council.resizeDrawingSurfaceToCanvas();');
    L.push('    MEMBERS.forEach(([code]) => setVote(code, votes[code] || RESET));');
    L.push('  },');
    L.push('});');
    L.push('window.addEventListener("resize", () => council.resizeDrawingSurfaceToCanvas());');
    L.push('');
    L.push('const votes = {}; // code -> value: what this page has set');
    L.push('function setVote(code, value) {');
    L.push('  const vm = council.viewModelInstance;');
    L.push('  if (vm) vm.enum(code).value = value;');
    L.push('  votes[code] = value;');
    L.push('  document.querySelectorAll(`[data-member="${code}"] button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === value)));');
    L.push('  tally();');
    L.push('}');
    L.push('');
    L.push('// ---------- buttons per member ----------');
    L.push('const list = document.getElementById("members");');
    L.push('MEMBERS.forEach(([code, name]) => {');
    L.push('  const row = document.createElement("div");');
    L.push('  row.className = "member";');
    L.push('  row.innerHTML = `<span>${name} <code>${code}</code></span><span class="seg" data-member="${code}">` +');
    L.push('    VALUES.map((v) => `<button type="button" data-v="${v}" aria-pressed="${v === RESET}">${v}</button>`).join("") + "</span>";');
    L.push('  row.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setVote(code, b.dataset.v)));');
    L.push('  list.appendChild(row);');
    L.push('});');
    L.push('document.getElementById("clear").addEventListener("click", () => { stop(); MEMBERS.forEach(([code]) => setVote(code, RESET)); });');
    L.push('');
    L.push('// ---------- the vote round ----------');
    L.push('// Everyone back to RESET, then member by member: first VOTING (the seat lights up), then the vote, drawn from OUTCOMES.');
    L.push('const go = document.getElementById("go"), statusEl = document.getElementById("status");');
    L.push('let timers = [], running = false;');
    L.push('function later(fn, ms) { timers.push(setTimeout(fn, ms)); }');
    L.push('function stop() {');
    L.push('  timers.forEach(clearTimeout);');
    L.push('  timers = [];');
    L.push('  running = false;');
    L.push('  go.classList.remove("running");');
    L.push('  go.textContent = ' + q('▶ ' + (r.label || 'Hold a vote')) + ';');
    L.push('}');
    L.push('function draw() {');
    L.push('  const total = Object.values(OUTCOMES).reduce((a, b) => a + b, 0);');
    L.push('  let x = Math.random() * total;');
    L.push('  for (const [value, weight] of Object.entries(OUTCOMES)) { x -= weight; if (x < 0) return value; }');
    L.push('  return Object.keys(OUTCOMES)[0];');
    L.push('}');
    L.push('function holdVote() {');
    L.push('  if (running) { stop(); statusEl.textContent = "stopped"; return; }');
    L.push('  const speed = Number(document.getElementById("speed").value) || 1;');
    L.push('  running = true;');
    L.push('  go.classList.add("running");');
    L.push('  go.textContent = "■ Stop";');
    L.push('  MEMBERS.forEach(([code]) => setVote(code, RESET));');
    L.push('  let i = 0;');
    L.push('  const next = () => {');
    L.push('    if (i === MEMBERS.length) { stop(); go.textContent = "▶ Vote again"; tally(); return; }');
    L.push('    const [code, name] = MEMBERS[i];');
    L.push('    setVote(code, VOTING);');
    L.push('    statusEl.textContent = `${name} is voting…`;');
    L.push('    later(() => { setVote(code, draw()); i++; later(next, TIMING.pause / speed); }, TIMING.think / speed);');
    L.push('  };');
    L.push('  later(next, TIMING.start / speed);');
    L.push('}');
    L.push('go.addEventListener("click", holdVote);');
    L.push('');
    L.push('// ---------- tally and outcome ----------');
    L.push('function tally() {');
    L.push('  const count = Object.fromEntries(Object.keys(OUTCOMES).map((v) => [v, 0]));');
    L.push('  MEMBERS.forEach(([code]) => { if (count[votes[code]] !== undefined) count[votes[code]]++; });');
    L.push('  Object.entries(count).forEach(([v, n]) => { document.getElementById("n-" + v).textContent = n; });');
    L.push('  const voted = Object.values(count).reduce((a, b) => a + b, 0);');
    L.push('  if (!running) statusEl.textContent = voted === MEMBERS.length ? `all ${voted} have voted` : `${MEMBERS.length - voted} to vote`;');
    L.push('  const box = document.getElementById("result");');
    L.push('  box.hidden = voted < MEMBERS.length; // the outcome once every member has voted, by the round or by hand');
    if (r.population) {
      L.push('  if (box.hidden) return;');
      L.push('  const total = MEMBERS.reduce((a, m) => a + m[2], 0);');
      L.push('  const yes = MEMBERS.filter(([code]) => votes[code] === "yes");');
      L.push('  const share = yes.reduce((a, m) => a + m[2], 0) / total;');
      L.push('  const need = Math.ceil(MAJORITY.states * MEMBERS.length - 1e-9);');
      L.push('  const statesOk = yes.length >= need, popOk = share >= MAJORITY.population;');
      L.push('  const adopted = statesOk && (popOk || MEMBERS.length - yes.length < MAJORITY.blocking);');
      L.push('  box.className = adopted ? "adopted" : "rejected";');
      L.push('  box.innerHTML = `<strong>${adopted ? "Adopted" : "Not adopted"}</strong> by qualified majority. ` +');
      L.push('    `${yes.length} of ${MEMBERS.length} states voted yes (${statesOk ? "at least " : ""}${need} needed), ` +');
      L.push('    `representing ${Math.round(share * 100)}% of the population (${popOk ? "at least " : ""}${Math.round(MAJORITY.population * 100)}% needed).`;');
    } else {
      L.push('  if (!box.hidden) box.textContent = "Everyone has voted.";');
    }
    L.push('}');
    L.push('tally();');
    L.push('</script>');
    L.push('</body>');
    L.push('</html>');
    return L.join('\n');
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
    if (o.round && s.round) p.push('round=1');
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
    if (s.round) out.push('- **Complete vote round:** ' + voteDemoUrl(s, base) + ' (one HTML file: vote button with stop, vote again and speed, a running tally, buttons per member, and the outcome' + (s.round.population ? ' under qualified majority, population figures included' : '') + '). If I want all of that, take this file as the starting point instead of the short example below.');
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
    if (s.round) {
      out.push('## The complete vote round');
      out.push('');
      out.push('One HTML file with everything the library page does: a vote button (stop, vote again, speed), a running tally, buttons per member and the outcome' + (s.round.population ? ' under qualified majority, with the population figures' : '') + ': ' + voteDemoUrl(s, base));
      out.push('');
      out.push('Open it, or give it to Claude Code as the starting point. The short example below has only the animation and `holdVote()`.');
      out.push('');
    }
    out.push('Also as a ready-to-open page: ' + exampleUrl(s, base));
    out.push('');
    out.push('```html');
    out.push(html(s, base, initial(s), o));
    out.push('```');
    out.push('');
    out.push('## React (TypeScript)');
    out.push('');
    out.push('```tsx');
    out.push(react(s, base, initial(s), o));
    out.push('```');
    out.push('');
    out.push('## Where scripts are not allowed (Canvas LMS, Moodle, Notion, Google Sites)');
    out.push('');
    out.push('```html');
    out.push(embed(s, base, initial(s), o));
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
    logo: 'Logos', illustration: 'Illustrations', character: 'Characters', interface: 'Interface', icon: 'Icons',
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
    initial: initial,
    settable: settable,
    triggers: triggers,
    html: html,
    react: react,
    embed: embed,
    embedSrc: embedSrc,
    voteDemo: voteDemo,
    voteDemoUrl: voteDemoUrl,
    prompt: prompt,
    readme: readme,
    llms: llms,
  };
});
