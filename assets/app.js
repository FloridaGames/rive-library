/* Rive Library: the website. A hash router with four views:

     #/                 the gallery (search: #/?q=clock&c=icon)
     #/s/<id>           one sample: live preview, controls, and the code to copy
     #/help             how to use it with Claude Code, Lovable, Gemini, plain HTML or Canvas LMS
     #/add              add a sample (assets/add.js)

   It reads library.json (written by tools/build.mjs) and nothing else. Every snippet comes from assets/core.js,
   the same generator the build uses for the READMEs, so the page and the docs always agree. */
(function () {
  'use strict';

  var C = window.RiveLib;
  var BASE = new URL('./', location.href).href;
  var view = document.getElementById('view');
  var lib = null, byId = {};
  var players = [], observer = null, current = '', lastGallery = '#/';

  var state = {
    values: {},                                     /* id -> control values, kept while you browse */
    width: {},                                      /* id -> display width for the snippets */
    bg: {},                                         /* id -> preview background */
    embed: {},                                      /* id -> { bg, every } */
    stack: remember('rl.stack', 'html'),            /* the AI prompt's example: html or react */
    tab: remember('rl.tab', 'prompt'),
  };

  /* ---------- small utilities ---------- */

  function remember(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'); }
  function bytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function copy(text, button, message) {
    var done = function () {
      if (button) {
        var was = button.innerHTML;
        button.classList.add('done');
        button.textContent = 'Copied ✓';
        setTimeout(function () { button.classList.remove('done'); button.innerHTML = was; }, 1600);
      }
      if (message) toast(message);
    };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { }
      document.body.removeChild(ta);
      if (ok) done(); else window.prompt('Copy this:', text);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  /* A small highlighter for the snippets: comments, strings, numbers, keywords and tags. Markdown (the AI prompt)
     gets headings and inline code, and its fenced blocks are highlighted as code. */
  var KW = /^(const|let|var|function|return|if|else|new|import|from|export|type|true|false|null|undefined|await|async|for|of|this)$/;
  function span(cls, s) { return '<span class="tok-' + cls + '">' + esc(s) + '</span>'; }
  function hl(code, lang) {
    if (lang === 'md') {
      var out = [], fence = null;
      code.split('\n').forEach(function (line) {
        if (/^```/.test(line)) { fence = fence ? null : (line.slice(3) || 'html'); out.push(span('c', line)); return; }
        if (fence) { out.push(hl(line, fence === 'tsx' ? 'tsx' : 'html')); return; }
        if (/^#/.test(line)) { out.push(span('h', line)); return; }
        out.push(esc(line).replace(/`([^`]+)`/g, '<span class="tok-s">`$1`</span>').replace(/\*\*([^*]+)\*\*/g, '<span class="tok-h">**$1**</span>'));
      });
      return out.join('\n');
    }
    var o = '', i = 0, n = code.length, m;
    while (i < n) {
      var rest = code.slice(i, i + 4), ch = code[i];
      if (rest === '<!--') { var e = code.indexOf('-->', i); e = e < 0 ? n : e + 3; o += span('c', code.slice(i, e)); i = e; continue; }
      if (ch === '/' && code[i + 1] === '/') { var nl = code.indexOf('\n', i); nl = nl < 0 ? n : nl; o += span('c', code.slice(i, nl)); i = nl; continue; }
      if (ch === '/' && code[i + 1] === '*') { var ce = code.indexOf('*/', i + 2); ce = ce < 0 ? n : ce + 2; o += span('c', code.slice(i, ce)); i = ce; continue; }
      if (ch === '"' || ch === "'" || ch === '`') {
        var j = i + 1;
        while (j < n && code[j] !== ch && !(ch !== '`' && code[j] === '\n')) { if (code[j] === '\\') j++; j++; }
        o += span('s', code.slice(i, j + 1)); i = j + 1; continue;
      }
      if (ch === '<' && /[\/A-Za-z!]/.test(code[i + 1] || '') && (m = /^<\/?[A-Za-z!][\w-]*/.exec(code.slice(i)))) {
        o += span('t', m[0]); i += m[0].length; continue;
      }
      if (/[0-9]/.test(ch) && !/[\w$]/.test(code[i - 1] || '') && (m = /^\d+(\.\d+)?/.exec(code.slice(i)))) {
        o += span('n', m[0]); i += m[0].length; continue;
      }
      if (/[A-Za-z_$]/.test(ch) && (m = /^[\w$]+/.exec(code.slice(i)))) {
        o += KW.test(m[0]) ? span('k', m[0]) : esc(m[0]); i += m[0].length; continue;
      }
      o += esc(ch); i++;
    }
    return o;
  }

  /* ---------- players: mount when visible, clean up when gone ---------- */

  function values(s) {
    if (!state.values[s.id]) state.values[s.id] = C.initial(s);
    return state.values[s.id];
  }

  function teardown() {
    players.forEach(function (p) { p.destroy(); });
    players = [];
    if (observer) { observer.disconnect(); observer = null; }
  }

  function mountCard(card) {
    var s = byId[card.dataset.id], stage = $('.card-stage', card), canvas = $('canvas', stage);
    if (!s || card._player || !window.rive) return;
    var p = RivePlayer.mount(canvas, s, {
      src: s.path + s.file,
      values: values(s),
      onReady: function () { stage.classList.add('ready'); },
    });
    card._player = p;
    players.push(p);
  }
  function unmountCard(card) {
    if (!card._player) return;
    card._player.destroy();
    players = players.filter(function (p) { return p !== card._player; });
    card._player = null;
    $('.card-stage', card).classList.remove('ready');
  }

  function watchCards(root) {
    if (!('IntersectionObserver' in window)) { $$('.card', root).forEach(mountCard); return; }
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) mountCard(en.target); else unmountCard(en.target); });
      }, { rootMargin: '160px 0px' });
    }
    $$('.card', root).forEach(function (c) { observer.observe(c); });
  }

  function cardHtml(s) {
    var wide = s.width / s.height > 1.6;
    var big = !wide && (s.displayWidth || s.width) >= 400;      /* a detailed picture gets a 2x2 card */
    var w = Math.max(72, Math.min(s.displayWidth || s.width, 420));
    var size = '--w:' + w + 'px;--ar:' + s.width + ' / ' + s.height + ';--arn:' + (s.width / s.height).toFixed(4);
    var meta = [C.categoryLabel(s.category).replace(/s$/, '')];
    if (s.collection) meta.push(s.collection); else meta.push(bytes(s.size));
    return '<article class="card' + (wide ? ' wide' : big ? ' big' : '') + '" data-id="' + esc(s.id) + '">' +
      '<div class="card-stage" style="--stage-bg:' + esc(s.background || '#ffffff') + '">' +
      (s.poster ? '<img alt="" loading="lazy"' + (s.recipe ? ' class="ghost"' : '') + ' src="' + esc(s.path + s.poster) + '" style="' + size + '">' : '') +
      '<canvas style="' + size + '" aria-hidden="true"></canvas></div>' +
      '<div class="card-body"><h3 class="card-title"><a href="#/s/' + esc(s.id) + '">' + esc(s.title) + '</a></h3>' +
      '<p class="card-meta">' + esc(meta.join(' · ')) + '</p>' +
      '<div class="card-actions"><button class="btn btn-sm" type="button" data-copy-prompt>' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
      'Copy AI prompt</button></div></div></article>';
  }

  function wireCards(root) {
    $$('.card', root).forEach(function (card) {
      var last = 0;
      card.addEventListener('mouseenter', function () {
        var now = Date.now();
        if (card._player && card._player.ready && now - last > 700) { last = now; card._player.hover(); }
      });
      var btn = $('[data-copy-prompt]', card);
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var s = byId[card.dataset.id];
        copy(promptFor(s), btn, 'AI prompt copied. Paste it into Claude Code, Lovable or Gemini.');
      });
    });
    watchCards(root);
  }

  function promptFor(s) {
    return C.prompt(s, BASE, values(s), { stack: state.stack, width: state.width[s.id], runtime: lib.runtime });
  }

  /* ---------- the gallery ---------- */

  function parseQuery(hash) {
    var q = {}, i = hash.indexOf('?');
    if (i < 0) return q;
    hash.slice(i + 1).split('&').forEach(function (kv) {
      var p = kv.split('=');
      if (p[0]) q[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
    });
    return q;
  }

  function matches(s, words, cat) {
    if (cat && s.category !== cat) return false;
    if (!words.length) return true;
    var hay = [s.id, s.title, s.summary, s.category, s.collection, (s.tags || []).join(' ')].join(' ').toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }

  function viewGallery(q) {
    var cats = {};
    lib.samples.forEach(function (s) { cats[s.category] = (cats[s.category] || 0) + 1; });
    view.innerHTML =
      '<section class="hero">' +
      '<h1>Rive animations, ready to <em>drop into</em> your project</h1>' +
      '<p class="lede">Logos, icons and interface pieces that move. Pick one, set it up with the controls, then copy a prompt for your AI tool, paste plain HTML, or embed it in Canvas.</p>' +
      '<div class="tools-row" aria-label="Works with">' +
      ['Claude Code', 'Lovable', 'Gemini', 'ChatGPT', 'Cursor', 'plain HTML', 'React', 'Canvas LMS'].map(function (t) { return '<span class="tool-pill">' + t + '</span>'; }).join('') +
      '</div></section>' +
      '<div class="finder"><div class="search">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
      '<input id="q" type="search" autocomplete="off" spellcheck="false" aria-label="Search animations" placeholder="Search ' + lib.samples.length + ' animations, e.g. clock, logo, tilburg">' +
      '</div><div class="chips" role="group" aria-label="Filter by type">' +
      '<button class="chip" type="button" data-cat="">All<span>' + lib.samples.length + '</span></button>' +
      Object.keys(cats).map(function (c) { return '<button class="chip" type="button" data-cat="' + esc(c) + '">' + esc(C.categoryLabel(c)) + '<span>' + cats[c] + '</span></button>'; }).join('') +
      '</div></div>' +
      '<section class="grid" id="grid" aria-live="polite"></section>' +
      '<p class="empty" id="none" hidden>Nothing matches that. Try another word, or <a href="#/add">add the animation you are looking for</a>.</p>';

    var input = $('#q');
    input.value = q.q || '';
    var cat = q.c || '';

    function apply(push) {
      var words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      var list = lib.samples.filter(function (s) { return matches(s, words, cat); });
      teardown();
      var grid = $('#grid');
      grid.innerHTML = list.map(cardHtml).join('');
      $('#none').hidden = list.length > 0;
      $$('.chip').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.cat === cat)); });
      wireCards(grid);
      if (push) {
        var parts = [];
        if (input.value.trim()) parts.push('q=' + encodeURIComponent(input.value.trim()));
        if (cat) parts.push('c=' + encodeURIComponent(cat));
        current = lastGallery = '#/' + (parts.length ? '?' + parts.join('&') : '');
        history.replaceState(null, '', current);
      }
    }
    var t = null;
    input.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { apply(true); }, 120); });
    $$('.chip').forEach(function (b) { b.addEventListener('click', function () { cat = b.dataset.cat; apply(true); }); });
    apply(false);
  }

  /* ---------- one sample ---------- */

  var BGS = [
    ['suggested', 'Suggested'], ['light', 'Light'], ['dark', 'Dark'], ['checker', 'Transparent'],
  ];
  function bgColor(s, which) {
    if (which === 'light') return '#ffffff';
    if (which === 'dark') return '#15171c';
    if (which === 'checker') return 'transparent';
    return s.background || '#ffffff';
  }

  var TABS = [
    ['prompt', 'AI prompt', 'Paste into <strong>Claude Code, Lovable, Gemini, ChatGPT or Cursor</strong>. It holds the file URL, every control with the values you set above, the rules AI tools tend to get wrong, and a working example.'],
    ['html', 'HTML', 'A complete page: save it as <code>.html</code> and open it, or copy the <code>&lt;canvas&gt;</code> and both <code>&lt;script&gt;</code> tags into your own page. Works in Gemini Canvas, CodePen and any static site.'],
    ['react', 'React', 'A TypeScript component for <strong>Lovable, Next.js, Vite</strong> and other React projects. Run <code>npm install @rive-app/react-canvas</code> first.'],
    ['embed', 'Embed', 'For places that strip scripts: <strong>Canvas LMS, Moodle, Notion, Google Sites, WordPress</strong>. Paste this in the HTML editor (in Canvas: Edit → the <code>&lt;/&gt;</code> HTML editor).'],
    ['files', 'Files', 'Download the files, or copy their URLs. The README is written for people and for AI tools alike.'],
  ];

  function controlHtml(s, c) {
    if (c.internal) return '';
    var v = values(s)[c.name];
    if (c.type === 'enum' && c.values && c.values.length <= 5) {
      /* a short enum is one row of buttons: the council vote has 25 of them, and a dropdown each is a chore */
      return '<div class="ctl ctl-inline" title="' + esc(c.description || '') + '"><span class="lbl">' + esc(c.label || c.name) +
        ' <code>' + esc(c.name) + '</code></span><div class="seg seg-sm" role="group" aria-label="' + esc(c.label || c.name) + '" data-enum="' + esc(c.name) + '">' +
        c.values.map(function (x) { return '<button type="button" data-val="' + esc(x) + '" aria-pressed="' + (x === v) + '">' + esc(x) + '</button>'; }).join('') +
        '</div></div>';
    }
    var anim = s.recipe && s.recipe.property === c.name;
    var head = '<div class="ctl-head"><label for="c-' + esc(c.name) + '">' + esc(c.label || c.name) + '</label>' +
      (c.type === 'number' ? '<span class="ctl-val" data-out="' + esc(c.name) + '"></span>' : '<code>' + esc(c.name) + '</code>') + '</div>';
    var desc = '<p class="ctl-desc">' + inline(anim ? 'Scrub it here; your code animates it from 0 to 1.' : (c.description || '')) + '</p>';
    var body = '';
    if (c.type === 'number') {
      if (c.snaps) {
        body = '<input type="range" id="c-' + esc(c.name) + '" data-ctl="' + esc(c.name) + '" min="0" max="' + (c.snaps.length - 1) + '" step="1" value="' + nearest(c.snaps, v) + '">';
      } else {
        var min = c.min !== undefined ? c.min : 0, max = c.max !== undefined ? c.max : Math.max(100, v * 2);
        body = '<input type="range" id="c-' + esc(c.name) + '" data-ctl="' + esc(c.name) + '" min="' + min + '" max="' + max + '" step="' + (c.step || (max - min > 10 ? 1 : 0.01)) + '" value="' + v + '">';
      }
    } else if (c.type === 'color') {
      body = '<div class="ctl-row"><input type="color" id="c-' + esc(c.name) + '" data-ctl="' + esc(c.name) + '" value="' + esc(v) + '"><input class="hex" type="text" data-hex="' + esc(c.name) + '" value="' + esc(v) + '" aria-label="' + esc(c.label || c.name) + ' as hex"></div>';
    } else if (c.type === 'boolean') {
      body = '<div class="ctl-row"><input type="checkbox" id="c-' + esc(c.name) + '" data-ctl="' + esc(c.name) + '"' + (v ? ' checked' : '') + '></div>';
    } else if (c.type === 'string') {
      body = '<div class="ctl-row"><input type="text" id="c-' + esc(c.name) + '" data-ctl="' + esc(c.name) + '" value="' + esc(v) + '"></div>';
    } else if (c.type === 'enum') {
      body = '<div class="ctl-row"><select id="c-' + esc(c.name) + '" data-ctl="' + esc(c.name) + '">' +
        (c.values || [v]).map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></div>';
    }
    return '<div class="ctl">' + head + body + desc + '</div>';
  }
  /* ---------- a vote round (samples with "round" in sample.json) ---------- */

  function roundBarHtml(s) {
    var r = s.round, outs = Object.keys(r.outcomes);
    return '<div class="round-bar"><button class="btn btn-primary" type="button" id="round-go">▶ ' + esc(r.label || 'Hold a vote') + '</button>' +
      '<div class="tally" id="tally" aria-live="polite">' +
      outs.map(function (o) { return '<span class="t t-' + esc(o) + '"><b data-count="' + esc(o) + '">0</b> ' + esc(o) + '</span>'; }).join('') +
      '<span class="t t-left" id="tally-left"></span></div>' +
      '<label class="speed">Speed <select id="round-speed"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></label></div>' +
      '<p class="round-result" id="round-result" hidden></p>';
  }

  function wireRound(s, player, setEnum, codeSoon) {
    var r = s.round, go = $('#round-go'), left = $('#tally-left'), out = $('#round-result');
    var labels = {}, run = null;
    (s.controls || []).forEach(function (c) { labels[c.name] = c.label || c.name; });
    var byName = {};
    (s.controls || []).forEach(function (c) { byName[c.name] = c; });
    function set(code, v) { if (byName[code]) setEnum(byName[code], v); }
    function tally(result, now) {
      var count = {};
      Object.keys(r.outcomes).forEach(function (o) { count[o] = 0; });
      Object.keys(result).forEach(function (c) { if (count[result[c]] !== undefined) count[result[c]]++; });
      Object.keys(count).forEach(function (o) { var b = $('[data-count="' + o + '"]'); if (b) b.textContent = count[o]; });
      var todo = r.order.length - Object.keys(result).length;
      left.textContent = now ? labels[now] + ' is voting…' : todo ? todo + ' to vote' : 'all ' + r.order.length + ' have voted';
    }
    function idle() { go.textContent = '▶ ' + (r.label || 'Hold a vote'); go.classList.remove('running'); }
    tally({}, null);
    left.textContent = r.order.length + ' members';
    go.addEventListener('click', function () {
      if (run && run.running()) { run.stop(); run = null; idle(); left.textContent = 'stopped'; return; }
      out.hidden = true;
      go.textContent = '■ Stop'; go.classList.add('running');
      tally({}, null);
      var speed = +$('#round-speed').value || 1;
      var timed = Object.assign({}, r, { start: (r.start || 700) / speed, think: (r.think || 800) / speed, pause: (r.pause || 200) / speed });
      run = VoteRound.run(set, timed, {
        onStep: function (code, v, i, result) { tally(result, v === r.pending ? code : null); codeSoon(); },
        onDone: function (result) {
          idle(); go.textContent = '▶ Vote again';
          if (!r.population) return;
          var m = VoteRound.majority(result, r), pct = Math.round(m.share * 100);
          out.className = 'round-result ' + (m.adopted ? 'adopted' : 'rejected');
          out.innerHTML = '<strong>' + (m.adopted ? 'Adopted' : 'Not adopted') + '</strong> by qualified majority. ' +
            m.count.yes + ' of ' + m.members + ' states voted yes ' + (m.statesOk ? '(at least ' + m.need + ' needed)' : '(' + m.need + ' needed)') +
            ', representing ' + pct + '% of the EU population ' + (m.popOk ? '(at least ' : '(') + Math.round(m.needShare * 100) + '% needed).' +
            (m.count.abstain ? ' Abstentions count as not voting yes.' : '');
          out.hidden = false;
        },
      });
    });
    players.push({ destroy: function () { if (run) run.stop(); } });
  }

  function nearest(list, v) {
    var best = 0;
    list.forEach(function (x, i) { if (Math.abs(x - v) < Math.abs(list[best] - v)) best = i; });
    return best;
  }
  function showNumber(c, v) {
    var n = Math.round(Number(v) * 100) / 100;
    return n + (c.unit ? (c.unit === '%' ? ' %' : ' ' + c.unit) : '');
  }

  function viewSample(id) {
    var s = byId[id];
    if (!s) { view.innerHTML = '<div class="prose"><h1>Not found</h1><p class="lede">There is no animation called “' + esc(id) + '”. <a href="#/">Back to the library</a></p></div>'; return; }
    document.title = s.title + ' · Rive Library';
    var bgWhich = state.bg[s.id] || 'suggested';
    var dispW = state.width[s.id] || s.displayWidth || s.width;
    var stageW = Math.max(120, Math.min(s.width, (s.displayWidth || s.width) * (s.category === 'icon' ? 3 : 1.6)));
    var ctrls = (s.controls || []).filter(function (c) { return !c.internal && c.type !== 'trigger'; });
    var trigs = (s.controls || []).filter(function (c) { return !c.internal && c.type === 'trigger'; });
    var hidden = (s.controls || []).filter(function (c) { return c.internal; });
    var enums = ctrls.filter(function (c) { return c.type === 'enum' && c.values && c.values.length > 1; });
    var manyEnums = enums.length >= 5 && !s.round;      /* a sample with a vote round has a better button */
    var tall = s.width / s.height < 1.3 && (s.displayWidth || s.width) >= 400;   /* a big square picture gets a taller stage */
    var related = lib.samples.filter(function (x) { return x.id !== s.id && (s.collection ? x.collection === s.collection : x.category === s.category); });

    view.innerHTML =
      '<nav class="crumbs"><a href="' + esc(lastGallery) + '">← All animations</a></nav>' +
      '<header class="detail-head"><p class="eyebrow">' + esc(C.categoryLabel(s.category).replace(/s$/, '')) + (s.collection ? ' · ' + esc(s.collection) : '') + '</p>' +
      '<h1>' + esc(s.title) + '</h1><p class="lede">' + inline(s.summary) + '</p></header>' +

      '<div class="detail-grid"><div class="col-main">' +
      '<section class="stage-wrap" aria-label="Preview">' + (s.round ? roundBarHtml(s) : '') +
      '<div class="stage' + (bgWhich === 'checker' ? ' checker' : '') + (tall ? ' tall' : '') + '" id="stage" style="--stage-bg:' + esc(bgColor(s, bgWhich)) + '">' +
      '<canvas id="preview" style="--w:' + Math.round(stageW) + 'px;--ar:' + s.width + ' / ' + s.height + ';--arn:' + (s.width / s.height).toFixed(4) + '"></canvas>' +
      '<span class="hint">' + (s.recipe ? 'Click to draw it again' : s.hoverTrigger ? 'Click the animation to play the ' + esc(s.hoverTrigger) : '') + '</span></div>' +
      '<div class="stage-bar"><div class="seg" role="group" aria-label="Preview background">' +
      BGS.map(function (b) { return '<button type="button" data-bg="' + b[0] + '" aria-pressed="' + (b[0] === bgWhich) + '"><span class="swatch" style="background:' + (b[0] === 'checker' ? 'repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0/8px 8px' : bgColor(s, b[0])) + '"></span>' + b[1] + '</button>'; }).join('') +
      '</div><span class="spacer"></span><button class="btn btn-sm" type="button" id="replay">↻ Replay</button></div>' +
      '</section>' +
      '<section class="about"><h2>What it does</h2><p>' + inline(s.description || s.summary) + '</p>' +
      (s.notes && s.notes.length ? '<ul>' + s.notes.map(function (n) { return '<li>' + inline(n) + '</li>'; }).join('') + '</ul>' : '') +
      '</section></div>' +

      '<aside class="panel">' +
      (ctrls.length || trigs.length ? '<section><h2>Controls</h2>' +
        (trigs.length ? '<div class="triggers">' + trigs.map(function (c) { return '<button class="btn btn-sm" type="button" data-fire="' + esc(c.name) + '" title="' + esc(c.description || '') + '">▶ ' + esc(c.label || c.name) + '</button>'; }).join('') + '</div>' : '') +
        '<div>' + ctrls.map(function (c) { return controlHtml(s, c); }).join('') + '</div>' +
        '<p style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' +
        (manyEnums ? '<button class="btn btn-sm" type="button" id="shuffle">Random values</button>' : '') +
        '<button class="btn btn-ghost btn-sm" type="button" id="reset">Reset to defaults</button></p></section>' : '') +
      '<section><h2>Details</h2><dl class="facts">' +
      '<dt>Artboard</dt><dd><code>' + esc(s.artboard) + '</code></dd>' +
      '<dt>State machine</dt><dd><code>' + esc(s.stateMachine) + '</code></dd>' +
      '<dt>Size</dt><dd>' + s.width + ' × ' + s.height + '</dd>' +
      '<dt>File</dt><dd>' + esc(s.file) + ' · ' + bytes(s.size) + '</dd>' +
      (s.author ? '<dt>Made by</dt><dd>' + esc(s.author) + '</dd>' : '') +
      (s.added ? '<dt>Added</dt><dd>' + esc(s.added) + '</dd>' : '') +
      (s.source ? '<dt>Source</dt><dd>' + esc(s.source) + '</dd>' : '') +
      (s.license ? '<dt>Use</dt><dd>' + esc(s.license) + '</dd>' : '') +
      hidden.map(function (c) { return '<dt>Also inside</dt><dd><code>' + esc(c.name) + '</code> ' + inline(c.description || '') + '</dd>'; }).join('') +
      '</dl></section>' +
      '</aside></div>' +

      '<section class="use" id="use"><div class="use-head"><h2>Use it</h2><p>The code follows the controls above: what you see is what you copy.</p></div>' +
      '<div class="tabs" role="tablist">' + TABS.map(function (t) {
        return '<button class="tab" role="tab" type="button" data-tab="' + t[0] + '" aria-selected="' + (t[0] === state.tab) + '">' + t[1] + (t[0] === 'prompt' ? '<span class="badge">easiest</span>' : '') + '</button>';
      }).join('') + '</div>' +
      '<div class="use-body"><p class="use-hint" id="hint"></p><div class="use-opts" id="opts"></div>' +
      '<div id="out"></div></div></section>' +

      (related.length ? '<section class="related"><h2>' + (s.collection ? 'More from ' + esc(s.collection) : 'More ' + esc(C.categoryLabel(s.category).toLowerCase())) + '</h2>' +
        '<div class="grid" id="related">' + related.slice(0, 12).map(cardHtml).join('') + '</div></section>' : '<div style="height:60px"></div>');

    /* the preview */
    var stage = $('#stage'), canvas = $('#preview');
    var player = RivePlayer.mount(canvas, s, {
      src: s.path + s.file,
      values: values(s),
      onReady: function () { syncOutputs(); },
      onTick: function (name, v) { var el = $('[data-ctl="' + name + '"]'); if (el) el.value = v; out(name, v); },
      onError: function () { stage.insertAdjacentHTML('beforeend', '<p class="notice err" style="position:absolute">The animation could not be loaded.</p>'); },
    });
    players.push(player);
    canvas.addEventListener('click', function () { if (s.recipe) player.replay(); });
    $('#replay').addEventListener('click', function () { player.replay(); });

    $$('[data-bg]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.bg[s.id] = b.dataset.bg;
        $$('[data-bg]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        stage.classList.toggle('checker', b.dataset.bg === 'checker');
        stage.style.setProperty('--stage-bg', bgColor(s, b.dataset.bg));
      });
    });

    /* the controls */
    function out(name, v) {
      var c = (s.controls || []).filter(function (x) { return x.name === name; })[0], el = $('[data-out="' + name + '"]');
      if (c && el) el.textContent = showNumber(c, v);
    }
    function syncOutputs() { ctrls.forEach(function (c) { if (c.type === 'number') out(c.name, values(s)[c.name]); }); }
    syncOutputs();
    var codeTimer = null;
    function codeSoon() { clearTimeout(codeTimer); codeTimer = setTimeout(renderUse, 150); }

    function setEnum(c, v) {
      values(s)[c.name] = v;
      player.set(c.name, v);
      $$('[data-enum="' + c.name + '"] button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.val === v)); });
    }
    ctrls.forEach(function (c) {
      var seg = $('[data-enum="' + c.name + '"]');
      if (seg) {
        $$('button', seg).forEach(function (b) { b.addEventListener('click', function () { setEnum(c, b.dataset.val); codeSoon(); }); });
        return;
      }
      var el = $('[data-ctl="' + c.name + '"]');
      if (!el) return;
      var read = function () {
        if (c.type === 'number') return c.snaps ? c.snaps[+el.value] : Number(el.value);
        if (c.type === 'boolean') return el.checked;
        return el.value;
      };
      el.addEventListener('input', function () {
        var v = read();
        values(s)[c.name] = v;
        player.set(c.name, v);
        if (c.type === 'number') out(c.name, v);
        if (c.type === 'color') { var hx = $('[data-hex="' + c.name + '"]'); if (hx) hx.value = v; }
        codeSoon();
      });
      el.addEventListener('change', function () { if (c.preview) player.fire(c.preview); });
      var hex = $('[data-hex="' + c.name + '"]');
      if (hex) hex.addEventListener('change', function () {
        var v = hex.value.trim();
        if (v[0] !== '#') v = '#' + v;
        if (!/^#[0-9a-f]{6}$/i.test(v)) { hex.value = values(s)[c.name]; return; }
        el.value = v.toLowerCase();
        el.dispatchEvent(new Event('input'));
      });
    });
    $$('[data-fire]').forEach(function (b) { b.addEventListener('click', function () { player.fire(b.dataset.fire); }); });
    if (s.round) wireRound(s, player, setEnum, codeSoon);
    /* random values, set one by one in a random order */
    var shuffle = $('#shuffle'), wave = [];
    if (shuffle) shuffle.addEventListener('click', function () {
      wave.forEach(clearTimeout);
      enums.slice().sort(function () { return Math.random() - 0.5; }).forEach(function (c, i) {
        var pick = c.values[1 + Math.floor(Math.random() * (c.values.length - 1))];
        wave.push(setTimeout(function () { setEnum(c, pick); codeSoon(); }, i * 90));
      });
    });
    var reset = $('#reset');
    if (reset) reset.addEventListener('click', function () {
      state.values[s.id] = C.defaults(s);
      ctrls.forEach(function (c) {
        var el = $('[data-ctl="' + c.name + '"]'), v = values(s)[c.name];
        if ($('[data-enum="' + c.name + '"]')) { setEnum(c, v); return; }
        if (!el) return;
        if (c.type === 'boolean') el.checked = !!v;
        else if (c.type === 'number' && c.snaps) el.value = nearest(c.snaps, v);
        else el.value = v;
        var hx = $('[data-hex="' + c.name + '"]'); if (hx) hx.value = v;
        player.set(c.name, v);
      });
      syncOutputs();
      player.replay();
      renderUse();
    });

    /* the code */
    function opts() {
      return { width: state.width[s.id] || s.displayWidth || s.width, runtime: lib.runtime, stack: state.stack };
    }
    function codeBlock(text, lang, wrap) {
      return '<div class="code"><button class="btn btn-sm copy" type="button" data-copy>Copy</button>' +
        '<pre' + (wrap ? ' class="wrap"' : '') + '><code>' + hl(text, lang) + '</code></pre></div>';
    }
    function renderUse() {
      var tab = state.tab, o = opts(), v = values(s), outEl = $('#out'), optsEl = $('#opts');
      $$('.tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === tab)); });
      $('#hint').innerHTML = TABS.filter(function (t) { return t[0] === tab; })[0][2];
      var widthField = '<label>Width on the page <input type="number" min="16" max="2000" step="1" id="opt-width" value="' + Math.round(o.width) + '"> px</label>';
      var text = '', lang = 'html', wrap = false;
      if (tab === 'prompt') {
        optsEl.innerHTML = '<span class="use-opts-lbl" style="font-size:14px;color:var(--muted)">Example in</span><div class="seg" role="group" aria-label="Example in">' +
          '<button type="button" data-stack="html" aria-pressed="' + (state.stack === 'html') + '">Plain HTML</button>' +
          '<button type="button" data-stack="react" aria-pressed="' + (state.stack === 'react') + '">React</button></div>' + widthField +
          '<span style="font-size:13.5px;color:var(--muted)">' + (state.stack === 'react' ? 'For Lovable, Bolt, v0, Next.js.' : 'For Gemini Canvas, ChatGPT, Claude Code on a plain site.') + '</span>';
        text = C.prompt(s, BASE, v, o); lang = 'md'; wrap = true;
      } else if (tab === 'html') {
        optsEl.innerHTML = widthField;
        text = C.html(s, BASE, v, o);
      } else if (tab === 'react') {
        optsEl.innerHTML = widthField;
        text = C.react(s, BASE, v, o); lang = 'tsx';
      } else if (tab === 'embed') {
        var eo = state.embed[s.id] || (state.embed[s.id] = { bg: 'transparent', every: 0, round: !!s.round });
        optsEl.innerHTML = widthField +
          '<label>Background <select id="opt-bg"><option value="transparent">Transparent</option><option value="suggested">' + esc(s.background || '#ffffff') + '</option></select></label>' +
          '<label>Replay every <input type="number" min="0" max="3600" step="1" id="opt-every" value="' + (eo.every || 0) + '"> s</label>' +
          (s.round ? '<label><input type="checkbox" id="opt-round"' + (eo.round ? ' checked' : '') + '> ' + esc(s.round.label || 'Vote') + ' button</label>' : '');
        $('#opt-bg').value = eo.bg;
        o.background = eo.bg === 'suggested' ? s.background : 'transparent';
        o.every = eo.every || 0;
        o.round = !!eo.round;
        text = C.embed(s, BASE, v, o);
        $('#opt-bg').addEventListener('change', function (e) { eo.bg = e.target.value; renderUse(); });
        $('#opt-every').addEventListener('change', function (e) { eo.every = Math.max(0, Math.round(+e.target.value || 0)); renderUse(); });
        if ($('#opt-round')) $('#opt-round').addEventListener('change', function (e) { eo.round = e.target.checked; renderUse(); });
      } else {
        optsEl.innerHTML = '';
        var files = [
          [s.file, 'the animation itself', s.path + s.file, bytes(s.size)],
          s.poster ? [s.poster, 'a static picture of it, as a fallback', s.path + s.poster, ''] : null,
          ['example.html', 'a complete page that runs it', s.path + 'example.html', ''],
          s.round ? ['vote-demo.html', 'the complete vote round: button, tally, buttons per member, outcome', s.path + 'vote-demo.html', ''] : null,
          ['README.md', 'documentation, for people and AI tools', s.path + 'README.md', ''],
          ['sample.json', 'the metadata: controls, sizes, license', s.path + 'sample.json', ''],
        ].filter(Boolean);
        outEl.innerHTML = '<ul class="files">' + files.map(function (f) {
          return '<li><span class="f-name">' + esc(f[0]) + '</span><span class="f-what">' + esc(f[1]) + (f[3] ? ' · <span class="f-size">' + f[3] + '</span>' : '') + '</span>' +
            '<a class="btn btn-sm" href="' + esc(f[2]) + '" download>Download</a>' +
            '<button class="btn btn-sm" type="button" data-url="' + esc(new URL(f[2], BASE).href) + '">Copy URL</button></li>';
        }).join('') + '</ul>' +
          '<p class="use-hint" style="margin:14px 0 0">Tip for Claude Code: give it the README URL, or the whole library at <a href="llms.txt">' + esc(BASE) + 'llms.txt</a>, and say what you want.</p>';
        $$('[data-url]', outEl).forEach(function (b) { b.addEventListener('click', function () { copy(b.dataset.url, b); }); });
        return;
      }
      outEl.innerHTML = codeBlock(text, lang, wrap);
      $('[data-copy]', outEl).addEventListener('click', function (e) {
        copy(text, e.currentTarget, tab === 'prompt' ? 'Paste it into your AI tool as your next message.' : null);
      });
      $$('[data-stack]', optsEl).forEach(function (b) {
        b.addEventListener('click', function () { state.stack = b.dataset.stack; store('rl.stack', state.stack); renderUse(); });
      });
      var wf = $('#opt-width');
      if (wf) wf.addEventListener('change', function () {
        var w = Math.round(+wf.value);
        if (w >= 16) { state.width[s.id] = w; renderUse(); }
      });
    }
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { state.tab = t.dataset.tab; store('rl.tab', state.tab); renderUse(); });
    });
    renderUse();

    var rel = $('#related');
    if (rel) wireCards(rel);
  }

  /* ---------- how to use ---------- */

  function viewHelp() {
    document.title = 'How to use · Rive Library';
    var llms = BASE + 'llms.txt';
    view.innerHTML =
      '<div class="prose"><p class="eyebrow">How to use</p><h1>From this library into your project</h1>' +
      '<p class="lede">Every animation here is one <code>.riv</code> file on a public URL. Your page loads it with the free Rive runtime and changes it through a few named controls. You never have to open Rive yourself.</p>' +
      '<div class="howto">' +
      '<article><h2>Claude Code <span class="tag">any stack</span></h2>' +
      '<ol><li>Open an animation, set it up with the controls, and copy the <strong>AI prompt</strong>.</li>' +
      '<li>Paste it into Claude Code. It knows the file URL, the controls and your values.</li></ol>' +
      '<p style="margin-top:10px">Or let Claude pick: Claude Code can read web pages, so you can say</p>' +
      '<div class="code"><pre class="wrap"><code>Read ' + esc(llms) + ' and add the self-drawing clock icon next to the page title.</code></pre></div></article>' +
      '<article><h2>Lovable, Bolt, v0 <span class="tag">React</span></h2>' +
      '<ol><li>On the <strong>AI prompt</strong> tab choose <strong>React</strong>, then copy.</li>' +
      '<li>Paste it into the chat. The tool installs <code>@rive-app/react-canvas</code> and builds the component.</li></ol>' +
      '<p class="callout">If the tool tries to redraw the logo in SVG or CSS instead, answer: “Use the .riv file from the URL in the prompt, don’t recreate it.” The prompt says so too, but this is the mistake they make most.</p></article>' +
      '<article><h2>Gemini, ChatGPT canvas <span class="tag">one HTML file</span></h2>' +
      '<ol><li>On the <strong>AI prompt</strong> tab keep <strong>Plain HTML</strong>, then copy.</li>' +
      '<li>Paste it into Gemini (Canvas) or ChatGPT. Both build a single HTML page, which is exactly what the example is.</li></ol></article>' +
      '<article><h2>Your own HTML page <span class="tag">no AI needed</span></h2>' +
      '<p>Copy the <strong>HTML</strong> tab. It is a complete page: open it as is, or take the <code>&lt;canvas&gt;</code> and the two <code>&lt;script&gt;</code> tags. Several animations on one page? Load <code>rive.js</code> only once.</p></article>' +
      '<article><h2>Canvas LMS, Moodle, Notion, Google Sites <span class="tag">no scripts allowed</span></h2>' +
      '<ol><li>Copy the <strong>Embed</strong> tab: an <code>&lt;iframe&gt;</code> that plays the animation from this library.</li>' +
      '<li>In Canvas: edit the page, open the HTML editor (<code>&lt;/&gt;</code>), paste, save.</li></ol>' +
      '<p style="margin-top:10px">Your control values travel along in the URL, and <em>Replay every</em> makes it play again now and then.</p></article>' +
      '<article><h2>Add your own <span class="tag">for colleagues</span></h2>' +
      '<p>Made something in Rive that others could use? <a href="#/add">Add a sample</a>: drop your <code>.riv</code>, the page reads what is inside, you add a title and a description, and it tells you how to put it in the library.</p></article>' +
      '</div>' +
      '<h2>Good to know</h2><ul>' +
      '<li><strong>Controls</strong> are the view model properties inside the file. Set them after the file has loaded (in <code>onLoad</code>, or once <code>rive</code> exists in React); before that there is nothing to set.</li>' +
      '<li><strong>Sharp on every screen:</strong> size the canvas with CSS and call <code>resizeDrawingSurfaceToCanvas()</code>; the snippets do both.</li>' +
      '<li><strong>Logos</strong> are the property of their owners. Use them for what their license line says.</li>' +
      '<li>The runtime comes from jsDelivr, pinned to version ' + esc(lib.runtime) + ', the one these files are tested with.</li>' +
      '</ul></div>';
  }

  /* ---------- router ---------- */

  function route() {
    var hash = location.hash || '#/';
    var path = hash.split('?')[0];
    if (hash === current && path === '#/') return;
    teardown();
    current = hash;
    document.title = 'Rive Library';
    $$('[data-nav]').forEach(function (a) { a.removeAttribute('aria-current'); });
    var nav = path === '#/help' ? 'help' : path === '#/add' ? 'add' : path === '#/' ? 'gallery' : '';
    var link = nav && $('[data-nav="' + nav + '"]');
    if (link) link.setAttribute('aria-current', 'page');
    window.scrollTo(0, 0);
    if (path.indexOf('#/s/') === 0) viewSample(decodeURIComponent(path.slice(4)));
    else if (path === '#/help') viewHelp();
    else if (path === '#/add' && window.RiveApp.views.add) window.RiveApp.views.add(view);
    else { lastGallery = hash; viewGallery(parseQuery(hash)); }
  }

  /* ---------- theme ---------- */

  $('#theme').addEventListener('click', function () {
    var root = document.documentElement;
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store('rl.theme', root.dataset.theme);
  });

  /* ---------- start ---------- */

  window.RiveApp = {
    views: {}, base: BASE, esc: esc, copy: copy, toast: toast, hl: hl, bytes: bytes, $: $, $$: $$,
    get lib() { return lib; },
    track: function (p) { players.push(p); },
  };

  fetch('library.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      lib = data;
      lib.samples.forEach(function (s) { byId[s.id] = s; });
      window.addEventListener('hashchange', route);
      route();
    })
    .catch(function (e) {
      view.innerHTML = '<div class="prose"><h1>The library did not load</h1><p class="lede">library.json is missing (' + esc(e.message) + '). Run <code>node tools/build.mjs --serve</code> and open the address it prints.</p></div>';
    });
})();
