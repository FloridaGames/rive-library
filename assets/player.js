/* Rive Library: puts one sample on one canvas, the same way the snippets do.

     var h = RivePlayer.mount(canvas, sample, { src, buffer, values, onReady, onError });
     h.set('kleur', '#0e2879');   h.fire('highlight');   h.replay();   h.hover();   h.destroy();

   `sample` is an entry from library.json. Values are applied on load and on every set(); a sample with a
   draw-on recipe draws itself in on load and again on replay(), exactly like the copied code does.
   Needs the global `rive` from @rive-app/canvas. */
(function (root) {
  'use strict';

  var buffers = {};   /* url -> Promise<ArrayBuffer>: a card scrolled back into view does not refetch its file */

  function fetchBuffer(url) {
    if (!buffers[url]) {
      buffers[url] = fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
        return r.arrayBuffer();
      });
      buffers[url].catch(function () { delete buffers[url]; });
    }
    return buffers[url];
  }

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function mount(canvas, sample, o) {
    o = o || {};
    var r = null, alive = true, raf = null, ro = null;
    var controls = {};
    (sample.controls || []).forEach(function (c) { controls[c.name] = c; });
    var values = {};
    (sample.controls || []).forEach(function (c) { if (c.type !== 'trigger' && c.default !== undefined) values[c.name] = c.default; });
    Object.keys(o.values || {}).forEach(function (k) { values[k] = o.values[k]; });

    var h = {
      sample: sample, ready: false, rive: null,
      set: set, fire: fire, replay: replay, hover: hover, draw: draw, stopDraw: stopDraw, destroy: destroy,
      get: function (name) { return values[name]; },
    };

    function input(name) {
      var list = r ? r.stateMachineInputs(sample.stateMachine) : null;
      if (!list) return null;
      for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
      return null;
    }

    function apply(name, value) {
      var c = controls[name];
      if (!r || !c) return;
      try {
        if (c.source === 'input') {
          var inp = input(name);
          if (inp) inp.value = c.type === 'boolean' ? !!value : Number(value);
          return;
        }
        var vm = r.viewModelInstance;
        if (!vm) return;
        if (c.type === 'number') { var n = vm.number(name); if (n) n.value = Number(value); }
        else if (c.type === 'color') { var col = vm.color(name), rgb = hexToRgb(value); if (col && rgb) col.argb(255, rgb[0], rgb[1], rgb[2]); }
        else if (c.type === 'boolean') { var b = vm.boolean(name); if (b) b.value = !!value; }
        else if (c.type === 'string') { var s = vm.string(name); if (s) s.value = String(value); }
        else if (c.type === 'enum') { var e = vm.enum(name); if (e) e.value = String(value); }
      } catch (err) { /* a wrong name in sample.json should not take the page down */ }
    }

    function set(name, value) {
      values[name] = value;
      if (h.recipeProperty() === name) stopDraw();
      apply(name, value);
    }

    function fire(name) {
      var c = controls[name];
      if (!r || !c) return;
      try {
        if (c.source === 'input') { var inp = input(name); if (inp) inp.fire(); return; }
        var t = r.viewModelInstance && r.viewModelInstance.trigger(name);
        if (t) t.trigger();
      } catch (err) { }
    }

    h.recipeProperty = function () { return sample.recipe && sample.recipe.type === 'draw-on' ? sample.recipe.property : null; };

    function stopDraw() { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }

    /* The draw-on recipe: 0 -> 1 with an ease-out, the same curve the snippets use. */
    function draw(ms) {
      var prop = h.recipeProperty();
      if (!prop || !r) return;
      ms = ms || (sample.recipe && sample.recipe.duration) || 700;
      stopDraw();
      var start = performance.now();
      apply(prop, 0);
      var step = function (now) {
        if (!alive) return;
        var t = Math.min(1, (now - start) / ms);
        values[prop] = 1 - Math.pow(1 - t, 3);
        apply(prop, values[prop]);
        raf = t < 1 ? requestAnimationFrame(step) : null;
        if (o.onTick) o.onTick(prop, values[prop]);
      };
      raf = requestAnimationFrame(step);
    }

    function replay(ms) {
      if (h.recipeProperty()) draw(ms);
      else if (sample.replayTrigger) fire(sample.replayTrigger);
    }
    function hover() {
      if (sample.hoverTrigger) fire(sample.hoverTrigger);
      else replay();
    }

    function destroy() {
      alive = false;
      stopDraw();
      if (ro) ro.disconnect();
      if (r) { try { r.cleanup(); } catch (e) { } }
      r = null; h.rive = null; h.ready = false;
    }

    function start(buffer) {
      if (!alive) return;
      var params = {
        canvas: canvas,
        artboard: sample.artboard,
        stateMachine: sample.stateMachine,
        autoplay: true,
        autoBind: true,
        layout: new root.rive.Layout({ fit: root.rive.Fit.Contain, alignment: root.rive.Alignment.Center }),
        onLoad: function () {
          if (!alive) return;
          r.resizeDrawingSurfaceToCanvas();
          h.ready = true; h.rive = r;
          Object.keys(values).forEach(function (k) {
            if (controls[k] && !controls[k].internal) apply(k, values[k]);
          });
          if (h.recipeProperty() && o.drawOnLoad !== false) draw();
          if (o.onReady) o.onReady(h);
        },
        onLoadError: function (e) { if (o.onError) o.onError(e); },
      };
      if (buffer) params.buffer = buffer; else params.src = o.src;
      r = new root.rive.Rive(params);
      if (root.ResizeObserver) {
        ro = new ResizeObserver(function () { if (h.ready && r) r.resizeDrawingSurfaceToCanvas(); });
        ro.observe(canvas);
      }
    }

    if (o.buffer) start(o.buffer);
    else if (o.src && o.cache !== false) fetchBuffer(o.src).then(start, function (e) { if (o.onError) o.onError(e); });
    else start(null);
    return h;
  }

  /* Read what is inside any .riv: artboards with their size, state machines with their inputs, view models with
     their properties and defaults. Used by the "Add a sample" page. */
  function inspect(canvas, buffer, artboard) {
    return new Promise(function (resolve, reject) {
      var r = new root.rive.Rive({
        buffer: buffer, canvas: canvas, autoplay: false, autoBind: true,
        artboard: artboard || undefined,
        layout: new root.rive.Layout({ fit: root.rive.Fit.Contain }),
        onLoadError: function (e) { reject(new Error('This file could not be read as a Rive file.')); },
        onLoad: function () {
          try {
            r.resizeDrawingSurfaceToCanvas();
            var info = { artboards: [], viewModels: [], artboard: null, width: r.artboardWidth, height: r.artboardHeight, defaultViewModel: null };
            var contents = r.contents || { artboards: [] };
            contents.artboards.forEach(function (a) {
              info.artboards.push({
                name: a.name, animations: a.animations,
                stateMachines: a.stateMachines.map(function (sm) {
                  return { name: sm.name, inputs: sm.inputs.map(function (i) { return { name: i.name, type: inputType(i.type) }; }) };
                }),
              });
            });
            info.artboard = artboard || (info.artboards[0] && info.artboards[0].name);
            var dvm = r.defaultViewModel ? r.defaultViewModel() : null;
            info.defaultViewModel = dvm ? dvm.name : null;
            for (var i = 0; i < (r.viewModelCount || 0); i++) {
              var vm = r.viewModelByIndex(i), inst = vm.defaultInstance ? vm.defaultInstance() : null;
              info.viewModels.push({
                name: vm.name,
                properties: vm.properties.map(function (p) { return { name: p.name, type: propType(p.type), value: readProp(inst, p) }; }),
              });
            }
            resolve({ info: info, rive: r });
          } catch (e) { reject(e); }
        },
      });
    });
  }

  function inputType(t) {
    var T = root.rive.StateMachineInputType || {};
    if (t === T.Number || t === 56) return 'number';
    if (t === T.Trigger || t === 58) return 'trigger';
    if (t === T.Boolean || t === 59) return 'boolean';
    return 'unknown';
  }
  function propType(t) { return t === 'enumType' ? 'enum' : t; }
  function readProp(inst, p) {
    if (!inst) return undefined;
    try {
      var t = propType(p.type);
      if (t === 'number') return inst.number(p.name).value;
      if (t === 'boolean') return inst.boolean(p.name).value;
      if (t === 'string') return inst.string(p.name).value;
      if (t === 'enum') { var e = inst.enum(p.name); return { value: e.value, values: e.values }; }
      if (t === 'color') {
        var v = inst.color(p.name).value >>> 0;
        return '#' + ('000000' + (v & 0xffffff).toString(16)).slice(-6);
      }
    } catch (e) { }
    return undefined;
  }

  root.RivePlayer = { mount: mount, inspect: inspect, fetchBuffer: fetchBuffer };
})(window);
