/* Rive Library: "Add a sample".

   Drop a .riv. The page reads what is inside with the Rive runtime (artboards, state machines and their inputs,
   view models and their properties with defaults), the contributor adds a title and a description, and out
   comes the sample.json the library needs, plus two ways to submit it: on the GitHub website, or by handing a
   prompt to Claude Code. Nothing is uploaded from this page; the file stays in the browser. */
(function () {
  'use strict';

  var A = window.RiveApp, C = window.RiveLib;
  var esc = A.esc, $ = A.$, $$ = A.$$;

  var LICENSES = [
    ['CC BY 4.0: free to use, credit the maker', 'CC BY 4.0. Free to use and adapt; credit the maker.'],
    ['CC0: free to use, no conditions', 'CC0. Free to use for anything, no credit needed.'],
    ['Tilburg University only', 'For use in Tilburg University teaching and projects only.'],
    ['Someone else\'s logo or brand', 'Logo of its owner. Use it in line with the owner\'s brand guidelines.'],
  ];
  var SUPPORTED = ['number', 'color', 'boolean', 'string', 'enum', 'trigger'];

  function slug(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function words(s) { return String(s || '').split(',').map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean); }
  function guessLabel(name) {
    var s = String(name).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function download(name, data, type) {
    var url = URL.createObjectURL(new Blob([data], { type: type }));
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  A.views.add = function (view) {
    document.title = 'Add a sample · Rive Library';
    var lib = A.lib;
    var st = { buffer: null, fileName: '', info: null, rive: null, artboard: null, stateMachine: null, rows: [] };

    view.innerHTML =
      '<div class="prose" style="max-width:none;padding-bottom:22px"><p class="eyebrow">Add a sample</p>' +
      '<h1>Share a Rive animation</h1>' +
      '<p class="lede" style="max-width:44em">Drop a <code>.riv</code> file. This page reads what is inside, you describe it in a few words, and you get the file the library needs plus the steps to add it. Nothing is uploaded: the file stays in your browser until you choose to submit it.</p></div>' +
      '<div class="add-grid">' +
      '<div>' +
      '<label class="drop" id="drop"><input type="file" accept=".riv" id="file" hidden>' +
      '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3m0 0 4 4m-4-4-4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>' +
      '<strong>Drop your .riv here</strong><span>or click to choose one. Export it from Rive with <em>Export → for runtime</em>.</span></label>' +
      '<p class="notice err" id="err" hidden style="margin-top:12px"></p>' +
      '<div id="inspect" hidden style="margin-top:16px">' +
      '<div class="stage-wrap"><div class="stage" id="a-stage" style="--stage-bg:#ffffff;height:300px"><canvas id="a-canvas" style="--w:420px;--ar:1"></canvas></div>' +
      '<div class="stage-bar"><span id="a-file" style="font:600 14px var(--mono)"></span><span class="spacer"></span>' +
      '<button class="btn btn-sm" type="button" id="a-other">Choose another file</button></div></div>' +
      '<div class="panel found" style="margin-top:16px"><h2>What is inside</h2><div id="a-found"></div></div>' +
      '</div></div>' +
      '<div id="a-form" class="panel" hidden></div>' +
      '</div>' +
      '<section id="a-result" class="use" hidden style="margin:0 0 70px"></section>';

    var drop = $('#drop'), input = $('#file');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) take(f); });
    input.addEventListener('change', function () { if (input.files[0]) take(input.files[0]); });
    $('#a-other').addEventListener('click', function () { input.value = ''; input.click(); });

    function fail(msg) { var e = $('#err'); e.textContent = msg; e.hidden = false; }

    function take(file) {
      $('#err').hidden = true;
      if (!/\.riv$/i.test(file.name)) { fail('That is not a .riv file. In Rive, use Export → for runtime.'); return; }
      if (file.size > 8 * 1048576) { fail('This file is ' + A.bytes(file.size) + '. Keep samples under 8 MB, so a page using it still loads quickly.'); return; }
      st.fileName = file.name;
      file.arrayBuffer().then(function (buf) { st.buffer = buf; read(null); });
    }

    function stopPreview() {
      if (st.rive) { try { st.rive.destroy ? st.rive.destroy() : st.rive.cleanup(); } catch (e) { } st.rive = null; }
    }

    /* Play it the way the library will: the chosen artboard with the chosen state machine, so hover and click
       listeners in the file work here too. */
    function preview() {
      stopPreview();
      st.rive = RivePlayer.mount($('#a-canvas'), { artboard: st.artboard, stateMachine: st.stateMachine || undefined, controls: [] }, { buffer: st.buffer });
      A.track(st.rive);
    }

    function read(artboard) {
      stopPreview();
      var canvas = $('#a-canvas');
      RivePlayer.inspect(canvas, st.buffer, artboard).then(function (res) {
        try { res.rive.cleanup(); } catch (e) { }
        st.info = res.info;
        st.artboard = res.info.artboard;
        var ab = res.info.artboards.filter(function (a) { return a.name === st.artboard; })[0] || { stateMachines: [] };
        if (!st.stateMachine || !ab.stateMachines.some(function (m) { return m.name === st.stateMachine; })) {
          st.stateMachine = ab.stateMachines[0] ? ab.stateMachines[0].name : null;
        }
        canvas.style.setProperty('--w', Math.min(420, res.info.width) + 'px');
        canvas.style.setProperty('--ar', res.info.width + ' / ' + res.info.height);
        preview();
        drop.hidden = true;
        $('#inspect').hidden = false;
        $('#a-file').textContent = st.fileName + ' · ' + A.bytes(st.buffer.byteLength);
        buildRows();
        showFound();
        showForm();
      }, function (e) { fail(e.message || 'This file could not be read.'); });
    }

    /* The controls the sample will offer: the default view model's properties plus the chosen state machine's
       inputs. Unsupported kinds (lists, nested view models, images) are listed but cannot be included. */
    function buildRows() {
      var info = st.info, old = {};
      st.rows.forEach(function (r) { old[r.source + ':' + r.name] = r; });
      var rows = [];
      var vm = info.viewModels.filter(function (v) { return v.name === info.defaultViewModel; })[0];
      (vm ? vm.properties : []).forEach(function (p) {
        rows.push(row('viewModel', p.name, p.type, p.value));
      });
      var ab = info.artboards.filter(function (a) { return a.name === st.artboard; })[0];
      var sm = ab && ab.stateMachines.filter(function (m) { return m.name === st.stateMachine; })[0];
      (sm ? sm.inputs : []).forEach(function (i) { rows.push(row('input', i.name, i.type, undefined)); });
      st.rows = rows;
      function row(source, name, type, value) {
        var prev = old[source + ':' + name];
        if (prev) return prev;
        var r = { source: source, name: name, type: type, value: value, include: SUPPORTED.indexOf(type) >= 0, label: guessLabel(name), description: '' };
        if (type === 'enum' && value && typeof value === 'object') { r.values = value.values; r.value = value.value; }
        if (type === 'number') {
          /* a guess the contributor can correct: 0..1 for fractions, otherwise room above the default */
          var v = typeof value === 'number' ? value : 0;
          if (v > 0 && v <= 1) { r.min = 0; r.max = 1; }
          else { r.min = Math.min(0, Math.floor(v)); r.max = Math.max(100, Math.ceil(Math.abs(v) * 2)); }
        }
        return r;
      }
    }

    function showFound() {
      var info = st.info;
      var ab = info.artboards.filter(function (a) { return a.name === st.artboard; })[0];
      var h = '';
      h += '<div class="field-row"><div class="field"><label for="a-ab">Artboard</label><select id="a-ab">' +
        info.artboards.map(function (a) { return '<option' + (a.name === st.artboard ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join('') +
        '</select><span class="help">' + info.width + ' × ' + Math.round(info.height) + '</span></div>' +
        '<div class="field"><label for="a-sm">State machine</label><select id="a-sm">' +
        (ab && ab.stateMachines.length ? ab.stateMachines.map(function (m) { return '<option' + (m.name === st.stateMachine ? ' selected' : '') + '>' + esc(m.name) + '</option>'; }).join('') : '<option value="">(none)</option>') +
        '</select><span class="help">' + (ab && ab.animations.length ? ab.animations.length + ' timeline' + (ab.animations.length > 1 ? 's' : '') : 'no timelines') + '</span></div></div>';
      if (!st.stateMachine) h += '<p class="notice err" style="margin-top:12px">This artboard has no state machine. Add one in Rive (even an empty one) so the animation plays and can be controlled, then export again.</p>';
      if (st.rows.length) {
        h += '<p style="margin-top:16px;font-size:14px;color:var(--muted)">These become the controls people can set. Give each a label and a short explanation.</p>' +
          '<table><thead><tr><th></th><th>Name</th><th>Label and what it does</th></tr></thead><tbody>' +
          st.rows.map(function (r, i) {
            var ok = SUPPORTED.indexOf(r.type) >= 0;
            return '<tr><td><input type="checkbox" data-inc="' + i + '"' + (r.include ? ' checked' : '') + (ok ? '' : ' disabled') + ' aria-label="Include ' + esc(r.name) + '"></td>' +
              '<td><code>' + esc(r.name) + '</code><br><span style="color:var(--muted);font-size:12.5px">' + esc(r.type) + (r.source === 'input' ? ' input' : '') +
              (r.value !== undefined && typeof r.value !== 'object' ? ' · ' + esc(r.value) : '') + (ok ? '' : ' · not supported') + '</span></td>' +
              '<td><input data-lbl="' + i + '" value="' + esc(r.label) + '" aria-label="Label for ' + esc(r.name) + '">' +
              '<input data-desc="' + i + '" value="' + esc(r.description) + '" placeholder="What does it do?" style="margin-top:5px" aria-label="Description for ' + esc(r.name) + '">' +
              (r.type === 'number' ? '<span class="range-row">From <input type="number" data-min="' + i + '" value="' + r.min + '" aria-label="Lowest value"> to <input type="number" data-max="' + i + '" value="' + r.max + '" aria-label="Highest value"></span>' : '') +
              '</td></tr>';
          }).join('') + '</tbody></table>';
      } else {
        h += '<p style="margin-top:14px;font-size:14px;color:var(--muted)">No controls found: no view model properties and no state machine inputs. That is fine for an animation that just plays.</p>';
      }
      $('#a-found').innerHTML = h;
      $('#a-ab').addEventListener('change', function (e) { st.stateMachine = null; read(e.target.value); });
      $('#a-sm').addEventListener('change', function (e) { st.stateMachine = e.target.value; preview(); buildRows(); showFound(); update(); });
      $$('[data-inc]').forEach(function (el) { el.addEventListener('change', function () { st.rows[+el.dataset.inc].include = el.checked; update(); }); });
      $$('[data-lbl]').forEach(function (el) { el.addEventListener('input', function () { st.rows[+el.dataset.lbl].label = el.value; update(); }); });
      $$('[data-desc]').forEach(function (el) { el.addEventListener('input', function () { st.rows[+el.dataset.desc].description = el.value; update(); }); });
      $$('[data-min]').forEach(function (el) { el.addEventListener('input', function () { st.rows[+el.dataset.min].min = Number(el.value); update(); }); });
      $$('[data-max]').forEach(function (el) { el.addEventListener('input', function () { st.rows[+el.dataset.max].max = Number(el.value); update(); }); });
    }

    function showForm() {
      var form = $('#a-form');
      if (!form.hidden) { update(); return; }
      var cats = Object.keys(C.CATEGORIES);
      var guess = st.fileName.replace(/\.riv$/i, '').replace(/[_-]+/g, ' ');
      form.innerHTML = '<h2>Describe it</h2>' +
        '<div class="field"><label for="f-title">Title</label><input id="f-title" value="' + esc(guess.charAt(0).toUpperCase() + guess.slice(1)) + '"></div>' +
        '<div class="field"><label for="f-summary">One line about it</label><input id="f-summary" placeholder="e.g. A thumbs-up that bounces when you click it."><span class="help">Shown on the card and in search.</span></div>' +
        '<div class="field"><label for="f-desc">More detail <span style="font-weight:400;color:var(--muted)">(optional)</span></label><textarea id="f-desc" placeholder="What happens when it loads, what the controls do, where it works well."></textarea></div>' +
        '<div class="field-row"><div class="field"><label for="f-cat">Type</label><select id="f-cat"><option value="">Choose…</option>' +
        cats.map(function (c) { return '<option value="' + c + '">' + esc(C.categoryLabel(c).replace(/s$/, '')) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="f-id">Short name (URL)</label><input id="f-id" spellcheck="false"><span class="help" id="f-id-help"></span></div></div>' +
        '<div class="field"><label for="f-tags">Search words</label><input id="f-tags" placeholder="e.g. button, like, feedback"><span class="help">Comma-separated. Think of what a colleague would type.</span></div>' +
        '<div class="field-row"><div class="field"><label for="f-author">Made by</label><input id="f-author" placeholder="Your name or team"></div>' +
        '<div class="field"><label for="f-width">Usual width on a page</label><input id="f-width" type="number" min="16" max="2000"></div></div>' +
        '<div class="field-row"><div class="field"><label for="f-license">Who may use it</label><select id="f-license">' +
        LICENSES.map(function (l, i) { return '<option value="' + i + '">' + esc(l[0]) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label for="f-bg">Looks best on</label><input id="f-bg" type="color" value="#ffffff"></div></div>';
      form.hidden = false;
      $('#f-width').value = Math.round(Math.min(st.info.width, 360));
      var idTouched = false;
      $('#f-id').value = slug($('#f-title').value);
      $('#f-id').addEventListener('input', function () { idTouched = true; update(); });
      $('#f-title').addEventListener('input', function () { if (!idTouched) $('#f-id').value = slug($('#f-title').value); update(); });
      $('#f-bg').addEventListener('input', function () { $('#a-stage').style.setProperty('--stage-bg', $('#f-bg').value); update(); });
      $$('input, textarea, select', form).forEach(function (el) { el.addEventListener('input', update); el.addEventListener('change', update); });
      update();
    }

    function sample() {
      var id = slug($('#f-id').value);
      var controls = st.rows.filter(function (r) { return r.include && SUPPORTED.indexOf(r.type) >= 0; }).map(function (r) {
        var c = { name: r.name, type: r.type, label: r.label || r.name };
        if (r.source === 'input') c.source = 'input';
        if (r.type === 'number') {
          c.default = typeof r.value === 'number' ? Math.round(r.value * 1000) / 1000 : 0;
          c.min = Math.min(r.min, r.max); c.max = Math.max(r.min, r.max);
          c.step = c.max - c.min <= 2 ? 0.01 : 1;
        } else if (r.type === 'boolean') c.default = !!r.value;
        else if (r.type === 'string') c.default = r.value || '';
        else if (r.type === 'color') c.default = r.value || '#000000';
        else if (r.type === 'enum') { c.default = r.value; if (r.values) c.values = r.values; }
        if (r.description) c.description = r.description;
        return c;
      });
      var lic = LICENSES[+$('#f-license').value] || LICENSES[0];
      var out = {
        id: id,
        title: $('#f-title').value.trim(),
        summary: $('#f-summary').value.trim(),
        description: $('#f-desc').value.trim() || undefined,
        category: $('#f-cat').value,
        tags: words($('#f-tags').value),
        file: id + '.riv',
        artboard: st.artboard,
        stateMachine: st.stateMachine,
        width: Math.round(st.info.width * 100) / 100,
        height: Math.round(st.info.height * 100) / 100,
        displayWidth: Math.round(+$('#f-width').value) || Math.round(st.info.width),
        background: $('#f-bg').value,
        controls: controls,
        author: $('#f-author').value.trim() || undefined,
        license: lic[1],
        added: today(),
      };
      var trig = controls.filter(function (c) { return c.type === 'trigger'; });
      if (trig.length) out.replayTrigger = trig[0].name;
      return JSON.parse(JSON.stringify(out));      /* drops the undefined fields */
    }

    function problems(s) {
      var p = [];
      if (!s.title) p.push('Give it a title.');
      if (!s.summary) p.push('Write the one line about it.');
      if (!s.category) p.push('Choose a type, so people can filter on it.');
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id)) p.push('The short name may only hold lowercase letters, digits and dashes.');
      else if (lib.samples.some(function (x) { return x.id === s.id; })) p.push('“' + s.id + '” is already in the library; pick another short name.');
      if (!s.stateMachine) p.push('The artboard needs a state machine (see the note on the left).');
      return p;
    }

    function update() {
      if ($('#a-form').hidden) return;
      var s = sample(), probs = problems(s), res = $('#a-result');
      $('#f-id-help').textContent = s.id ? 'samples/' + s.id + '/' : '';
      res.hidden = false;
      if (probs.length) {
        res.innerHTML = '<div class="use-head"><h2>Almost there</h2></div><div class="use-body"><ul style="margin:0;padding-left:20px">' +
          probs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
        return;
      }
      var json = JSON.stringify(s, null, 2) + '\n';
      var repo = lib.repo, branch = lib.branch || 'main';
      var newFile = 'https://github.com/' + repo + '/new/' + branch + '?filename=' + encodeURIComponent('samples/' + s.id + '/sample.json') + '&value=' + encodeURIComponent(json);
      var upload = 'https://github.com/' + repo + '/upload/' + branch + '/samples/' + s.id;
      var claude = 'Add a sample to the Rive Library in this repository (' + repo + ').\n\n' +
        '1. Create the folder samples/' + s.id + '/.\n' +
        '2. Copy my file "' + st.fileName + '" into it as ' + s.id + '.riv (ask me where the file is if you cannot find it).\n' +
        '3. Write samples/' + s.id + '/sample.json with exactly this content:\n\n```json\n' + json + '```\n\n' +
        '4. Run `node tools/build.mjs --check` and fix anything it reports.\n' +
        '5. Commit as "Add sample: ' + s.title + '" and push. The site rebuilds itself.';

      res.innerHTML = '<div class="use-head"><h2>Add it to the library</h2><p>Two files go into <code>samples/' + esc(s.id) + '/</code>: your animation and this description.</p></div>' +
        '<div class="use-body">' +
        '<p style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px"><button class="btn" type="button" id="dl-json">Download sample.json</button>' +
        '<button class="btn" type="button" id="dl-riv">Download ' + esc(s.id) + '.riv</button></p>' +
        '<div class="tabs" role="tablist" style="padding:0 0 0;margin-bottom:16px"><button class="tab" role="tab" type="button" data-way="github" aria-selected="true">On the GitHub website</button><button class="tab" role="tab" type="button" data-way="claude" aria-selected="false">With Claude Code</button></div>' +
        '<div data-show="github"><ol class="steps">' +
        '<li><strong>Create the description.</strong> <a class="btn btn-sm btn-primary" target="_blank" rel="noopener" href="' + esc(newFile) + '">Open sample.json on GitHub</a><br><span style="color:var(--muted);font-size:14.5px">The file is filled in already. Click <em>Commit changes</em>. Without write access GitHub offers to <em>propose</em> the change instead; that works too.</span></li>' +
        '<li><strong>Upload the animation</strong> into that same folder: <a class="btn btn-sm" target="_blank" rel="noopener" href="' + esc(upload) + '">Upload ' + esc(s.id) + '.riv</a><br><span style="color:var(--muted);font-size:14.5px">Use the downloaded <code>' + esc(s.id) + '.riv</code>, so the name matches.</span></li>' +
        '<li><strong>Wait a minute or two.</strong> The library rebuilds itself and your animation appears at <code>#/s/' + esc(s.id) + '</code>.</li>' +
        '</ol></div>' +
        '<div data-show="claude" hidden><p class="use-hint">In a clone of the library repository, paste this into Claude Code:</p>' +
        '<div class="code"><button class="btn btn-sm copy" type="button" id="cp-claude">Copy</button><pre class="wrap"><code>' + A.hl(claude, 'md') + '</code></pre></div></div>' +
        '<details style="margin-top:18px"><summary style="cursor:pointer;font-weight:600">Show sample.json</summary>' +
        '<div class="code" style="margin-top:10px"><button class="btn btn-sm copy" type="button" id="cp-json">Copy</button><pre><code>' + A.hl(json, 'js') + '</code></pre></div></details>' +
        '</div>';
      $('#dl-json').addEventListener('click', function () { download('sample.json', json, 'application/json'); });
      $('#dl-riv').addEventListener('click', function () { download(s.id + '.riv', st.buffer, 'application/octet-stream'); });
      $('#cp-claude').addEventListener('click', function (e) { A.copy(claude, e.currentTarget); });
      $('#cp-json').addEventListener('click', function (e) { A.copy(json, e.currentTarget); });
      $$('[data-way]', res).forEach(function (t) {
        t.addEventListener('click', function () {
          $$('[data-way]', res).forEach(function (x) { x.setAttribute('aria-selected', String(x === t)); });
          $$('[data-show]', res).forEach(function (x) { x.hidden = x.dataset.show !== t.dataset.way; });
        });
      });
    }
  };
})();
