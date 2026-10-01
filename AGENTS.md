# Rive Library: notes for coding agents

A static site that lists Rive animations and generates the code to use them. Read README.md for the layout;
CONTRIBUTING.md has the full `sample.json` reference.

## The rules

- **`samples/<id>/` is the only source.** A sample is its `.riv` plus `sample.json` (plus an optional static
  poster). `library.json`, `llms.txt`, every `README.md` and `example.html` are generated into `dist/` by
  `tools/build.mjs`. Never write or commit `dist/`.
- **All generated code comes from `assets/core.js`**, which runs in the browser and in Node. Change a snippet
  there and both the site and the docs follow. Do not hand-write a snippet anywhere else.
- **Node standard library only.** No `npm install`, no dependencies, no bundler. The site is plain ES5-style
  scripts so it runs from any static host.
- The runtime version lives in one place: `runtime` in `library.config.json`. Bumping it means testing every
  sample again (see below).

## Adding a sample

1. Create `samples/<id>/` (`id`: lowercase, digits, dashes) and copy the `.riv` in as `<id>.riv`.
2. Find out what is inside. The quickest way: `node tools/build.mjs --serve`, open `#/add` and drop the file;
   it lists artboards (with size), state machines, inputs and view model properties with defaults, and writes
   a starting `sample.json`.
3. Write `samples/<id>/sample.json`. The names in `artboard`, `stateMachine` and `controls` must match the file
   exactly. Give every control a `label` and a one-line `description`: those end up in the AI prompt.
4. `node tools/build.mjs --check` must pass.
5. Commit as `Add sample: <title>`. Pushing to `main` deploys.

## Testing a change

`node tools/build.mjs --serve` serves `dist/` on http://localhost:8780/. What has to work after a change:

- the gallery shows every card, and the animations play;
- on a detail page, the controls change the preview, and the HTML, React and Embed tabs follow them;
- the copied HTML runs on its own (save it as a file and open it), with the values you set.

A browser tab in the background does not run `requestAnimationFrame`, so drawn-in icons stay empty there. That
is the test environment, not a bug.

## Known facts about these files

- The logos (`logo-eu`, `logo-tiu`) come from `rive-showcase` (`tools/gen-logo.py`, `gen-logo-tiu.py`, shared rig
  in `tools/logo_rig.py`). Their durations work in steps (`snaps`), because Rive cannot read a speed from data.
- The icons come from `eu-lobby-game/rive-iconen/maak-icoon.py`. The file has no timeline on purpose: the page
  animates `tekenen` 0→1 (the `draw-on` recipe). Colour is `kleur`, stroke width `dikte` in artboard units
  (240 wide, so 10× Lucide).
- Property names are Dutch because the source projects are. Keep them: they are the API of the file.
- Use `stateMachine` (singular). Runtime 2.42 warns that `stateMachines` is deprecated.
