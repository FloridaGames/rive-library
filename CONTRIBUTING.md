# Adding a sample

Three ways, from easiest to most hands-on.

## 1. On the site (no install)

Go to **Add a sample** in the gallery and drop your `.riv`. The page reads what is inside, you fill in a title,
one line about it, a type and search words, and it gives you:

1. a link that opens `samples/<id>/sample.json` on GitHub, **already filled in**: click *Commit changes*
   (without write access GitHub offers to propose the change; that works too);
2. a link to upload the `.riv` into the same folder.

A minute later the site has rebuilt itself and the sample is live.

## 2. With Claude Code

The Add page also gives you a prompt for Claude Code. Or simply, in a clone of this repository:

> Add `~/Downloads/thumbs-up.riv` to the library as a new sample.

Claude reads [AGENTS.md](AGENTS.md), inspects the file, writes `sample.json`, runs the check and commits.

## 3. By hand

Create `samples/<id>/` with the `.riv` and a `sample.json`, then run `node tools/build.mjs --check`.

## Before you export from Rive

- **Give the artboard a state machine**, even an empty one. Without it nothing plays and nothing can be controlled.
- **Use a view model with named properties** for anything people should be able to change (colours, durations,
  texts, triggers). The library reads them and turns them into controls and code. State machine inputs work
  too, but view models are the current way.
- **Name things in plain words.** The property names end up in everyone's code.
- Export with *Export → for runtime*. Keep it under 8 MB.

## sample.json

```json
{
  "id": "thumbs-up",
  "title": "Thumbs up",
  "summary": "A thumbs-up that bounces when you click it.",
  "description": "Longer text: what happens on load, what the controls do, where it works well.",
  "category": "interface",
  "tags": ["like", "feedback", "button"],
  "file": "thumbs-up.riv",
  "poster": "thumbs-up.svg",
  "artboard": "Thumb",
  "stateMachine": "Thumb",
  "width": 200,
  "height": 200,
  "displayWidth": 96,
  "background": "#ffffff",
  "controls": [
    { "name": "bounce", "type": "trigger", "label": "Bounce" },
    { "name": "color", "type": "color", "label": "Colour", "default": "#0e2879" },
    { "name": "size", "type": "number", "label": "Size", "default": 1, "min": 0.5, "max": 2, "step": 0.1, "unit": "×" }
  ],
  "replayTrigger": "bounce",
  "notes": ["Anything a user or an AI tool should know."],
  "author": "Your name",
  "license": "CC BY 4.0. Free to use and adapt; credit the maker.",
  "added": "2026-10-01"
}
```

| Field | Required | |
|---|---|---|
| `id` | yes | lowercase, digits and dashes; equal to the folder name |
| `title`, `summary` | yes | `summary` is one line: it is on the card, in search and in `llms.txt` |
| `category` | yes | `logo`, `icon`, `character`, `interface`, `illustration`, `background` or `other` |
| `file` | yes | the `.riv` in the same folder |
| `artboard`, `stateMachine` | yes | exactly as named in Rive |
| `width`, `height` | yes | the artboard size; snippets keep this aspect ratio |
| `controls` | | what people can change, see below |
| `poster` | | a static `.svg`/`.png` of it, shown while loading and offered as a fallback |
| `displayWidth` | | the usual width on a page, in px (the snippets start from it) |
| `background` | | the colour it looks best on |
| `collection` | | groups related samples, e.g. `"Lobby Game icons"` |
| `preset` | | values the page and the examples start with, e.g. `{ "de": "yes" }`; *Reset* goes back to the defaults |
| `round` | | a vote round over enum controls: `order`, `reset`, `pending`, `outcomes` (weights), timing (`start`, `think`, `pause` in ms) and optionally `population` + `majority` for a double-majority outcome. The page gets a vote button above the preview, the snippets a `holdVote()` |
| `replayTrigger` | | the trigger the *Replay* button fires |
| `hoverTrigger` | | the trigger fired when you hover its card (else: replay) |
| `recipe` | | behaviour the page adds, see below |
| `notes`, `description`, `tags`, `author`, `source`, `license`, `added` | | shown on the page and in the docs |

**A control** is `{ "name", "type", "label", "description", "default" }` with `type` one of `number`, `color`,
`boolean`, `string`, `enum`, `trigger`. Numbers take `min`, `max`, `step`, `unit`, and `snaps` (a list) when the
file only knows certain values. `"preview": "<trigger>"` replays that trigger after the slider is released.
`"internal": true` hides it from the controls (the file sets it itself). `"source": "input"` marks a state
machine input instead of a view model property.

**A recipe** is behaviour the file leaves to the page. There is one: `{ "type": "draw-on", "property": "tekenen",
"duration": 700 }` animates a 0..1 property with an ease-out on load and on click. The snippets include the code.
