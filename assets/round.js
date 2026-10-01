/* Rive Library: a vote round, for samples with a "round" in sample.json (the EU Council vote).

     var r = VoteRound.run(set, round, { onStep: fn(code, value, index, result), onDone: fn(result) });
     r.stop();
     VoteRound.majority(result, round)   // the outcome under a double majority (the Council's qualified majority)

   `set(code, value)` writes one control; the page passes its own, so its buttons follow. Everyone goes back to
   `round.reset` first; then, country by country in `round.order`, first `round.pending` (the voting moment) and
   after `round.think` ms the vote itself, drawn at random with the weights in `round.outcomes`. */
(function (root) {
  'use strict';

  function pick(weights) {
    var keys = Object.keys(weights), total = 0, r;
    keys.forEach(function (k) { total += weights[k]; });
    r = Math.random() * total;
    for (var i = 0; i < keys.length; i++) { r -= weights[keys[i]]; if (r < 0) return keys[i]; }
    return keys[keys.length - 1];
  }

  function run(set, round, o) {
    o = o || {};
    var stopped = false, timers = [], result = {}, i = 0;
    var order = round.order || [];
    function later(fn, ms) { timers.push(setTimeout(function () { if (!stopped) fn(); }, ms)); }
    function next() {
      if (i >= order.length) { if (o.onDone) o.onDone(result); return; }
      var code = order[i];
      set(code, round.pending);
      if (o.onStep) o.onStep(code, round.pending, i, result);
      later(function () {
        var v = o.pick ? o.pick(code) : pick(round.outcomes);
        result[code] = v;
        set(code, v);
        if (o.onStep) o.onStep(code, v, i, result);
        i++;
        later(next, round.pause || 200);
      }, round.think || 800);
    }
    order.forEach(function (code) { set(code, round.reset); });
    later(next, round.start || 700);
    return {
      result: result,
      stop: function () { stopped = true; timers.forEach(clearTimeout); },
      running: function () { return !stopped && i < order.length; },
    };
  }

  /* The double majority: at least `states` of the members vote yes, and they hold at least `population` of the
     people. A blocking minority needs at least `blocking` members; with fewer against, the population test is
     deemed met. Abstaining counts as not voting yes. */
  function majority(result, round) {
    var m = round.majority || { states: 0.55, population: 0.65, blocking: 4 };
    var pop = round.population || {}, order = round.order || [];
    var total = 0, yesPop = 0, count = { yes: 0, no: 0, abstain: 0 };
    order.forEach(function (c) {
      total += pop[c] || 0;
      var v = result[c];
      if (count[v] !== undefined) count[v]++;
      if (v === 'yes') yesPop += pop[c] || 0;
    });
    var need = Math.ceil(m.states * order.length - 1e-9);
    var statesOk = count.yes >= need;
    var share = total ? yesPop / total : 0;
    var popOk = share >= m.population;
    var blockers = order.length - count.yes;
    return {
      adopted: statesOk && (popOk || blockers < m.blocking),
      count: count, need: need, statesOk: statesOk, share: share, popOk: popOk,
      needShare: m.population, members: order.length,
    };
  }

  root.VoteRound = { run: run, majority: majority, pick: pick };
})(window);
