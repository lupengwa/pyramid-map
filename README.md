# Pyramid Map

Pyramid Map is a local web renderer and editor for shared human-agent proof trees.
It presents one conclusion at the top, supporting claims below it, and detailed evidence in deeper branches.
GWE plus Notes is the default card pattern, while every node may define its own ordered sections and visual style.

The bundled `maps/native-dsh-web-path/` presentation demonstrates the complete format.

## Start the bundled map

Double-click:

```text
maps/native-dsh-web-path/Native DSH Web Path.command
```

The launcher verifies and starts one shared local server when needed, then opens this presentation in its own browser tab.
Later launchers reuse that server, so different maps do not compete for the same port.
The launcher terminal may close after the tab opens.

The equivalent terminal path is:

```sh
bun install
bun run start
```

The shared server uses `http://127.0.0.1:4318` by default, while each tab URL carries its own destination map path.
Set `PYRAMID_MAP_PORT` when another service occupies that port.
Run `bun run map stop` to stop the shared server.

## Presentation contract

Every generated presentation is a self-contained data directory:

```text
map-name/
├── tree.json
├── verification.json
├── .pyramid-map/
│   └── agent-base.json
└── Map Name.command
```

The `.command` filename is the human-facing map name.
Clicking it must call `pyramid-map --map <containing-directory> open` so the shared server opens that destination in a separate tab.
The requested destination is the one durable map directory.
Generated maps do not need a second copy under this repository's `maps/` folder.

### Current map and agent baseline

`tree.json` is the current map and the browser's only content-write target.

`.pyramid-map/agent-base.json` is the last map the agent generated or explicitly accepted.
Before changing an existing presentation, the agent compares the normalized baseline tree with the current tree.
Added, removed, moved, and updated nodes are cumulative evidence of human intention since the agent last completed the map.

When an agent changes the map, it first writes and validates the final `tree.json`.
After validation, it writes the exact same JSON bytes to `.pyramid-map/agent-base.json`.
An agent-completed map therefore has identical current and baseline files.

`verification.json` is human-owned review state.
Content edits do not change it, and verification edits do not change the tree revision.

No action log is required.

### Tree schema

The current schema is a version 2 document:

```json
{
  "version": 2,
  "revision": 1,
  "root": {
    "id": "G0",
    "title": "The main conclusion holds.",
    "pattern": "gwe-notes",
    "style": "proof",
    "sections": [
      { "key": "given", "label": "Given", "body": "Supporting conditions hold." },
      { "key": "when", "label": "When", "body": "The capability is exercised." },
      { "key": "expect", "label": "Expect", "body": "The conclusion follows." },
      { "key": "notes", "label": "Notes", "body": "Relevant qualification." }
    ],
    "evidence": "source",
    "source": "path/to/source.ts:42",
    "children": []
  }
}
```

Each node requires a unique ID, title, pattern, style, one to eight ordered sections, evidence kind, and source.
Every non-root node should also carry one plain-text `relationship` sentence of at most 180 characters.
It states what the child adds to its parent and stays visible on the card without a click.
The child detail view repeats it directly below the path, before the node sections, while evidence and source remain separate.
The browser editor requires this sentence whenever a child is added or edited, while older maps without it remain readable.
The supported styles are `proof`, `editorial`, `signal`, and `mental-model`.
Every style shows the full node title.
The `mental-model` style promotes the first section as the at-a-glance card content and keeps the remaining sections in the node detail.
The supported evidence kinds are `structural`, `source`, and `e2e`.
Section bodies support plain text and balanced `<code>...</code>` inline markup.
The legacy Given, When, Expect, and Notes fields remain readable and normalize to the version 2 node model.

## Production flow

`server.ts` is the web production entry point and owns the one loopback server shared by every open map.
It supplies a default presentation for direct starts, while each browser tab selects its destination through the `map` URL parameter.

`src/map-store-registry.ts` lazily creates one data store per absolute destination path.
This keeps map state isolated even when multiple tabs and agents use the same server.

`src/shared-server.ts` owns startup locking, health detection, detached process lifetime, map URLs, and clean shutdown.
Concurrent launchers either start the server once or reuse the ready process.

`src/data-store.ts` owns browser edits, generated child IDs, verification, atomic JSON writes, and the cross-process map lock.
Browser content mutations increment the tree revision.
Verification mutations write only `verification.json`.

`src/http-app.ts` serves the browser assets and resolves every tree and verification API request against the map selected by that tab.
The server binds only to `127.0.0.1`.

`public/map-model.js` derives visible branches, card rows, geometry, and smooth parent-child paths.
`public/app.js` renders the map, keeps each child-to-parent relationship visible, handles zoom and pan, opens node details, and saves human edits.
`public/styles.css` owns the compact two-level default layout, card styles, verified state, and editor.

`bin/pyramid-map` is the agent inspection entrance.
Its stdout uses TOON and its default map is `maps/native-dsh-web-path/`.

```sh
bun run map
bun run map --map /path/to/map-name open
bun run map stop
bun run map view G2
bun run map diff --full
bun run map diff --full --map /path/to/map-name
```

`src/map-diff.ts` compares stable node IDs and reports additions, removals, parent moves, and content updates.
The diff ignores verification because verification is not map content.

## Create another presentation

Create the map directly in the requested destination directory with `tree.json`, `verification.json`, and `.pyramid-map/agent-base.json`.
Initially, write identical JSON to the current and baseline files.
Keep this destination as the sole durable copy.

Copy `templates/map-launcher.command` into the destination.
Rename it to the human-facing map name and replace `__PYRAMID_MAP_DIRECTORY__` with the absolute path to this repository.
Keep the launcher executable.

```sh
chmod +x "/path/to/map-name/Map Name.command"
```

The user can then click the named launcher to open that map in its own tab on the shared server.

## Verification gate

Run:

```sh
bun run verify
```

The gate validates schemas, current-versus-baseline behavior, tree mutations, human verification, authored child-to-parent relationships, compact layout, wide fan-out, CLI output, browser assets, per-tab map isolation, and shared-server launcher reuse.
All mutation checks run against temporary files.
The bundled map and its verification state remain unchanged.

`bun run start` always runs this gate before starting the server.

## Repository map

```text
pyramid-map/
├── server.ts                         Web production entry
├── bin/pyramid-map                   Agent inspection entrance
├── src/
│   ├── cli.ts                        TOON read, view, and diff commands
│   ├── data-store.ts                 Browser mutation and persistence seam
│   ├── http-app.ts                   Local web and JSON API
│   ├── map-diff.ts                   Semantic baseline comparison
│   ├── map-store-registry.ts         Per-destination data-store isolation
│   ├── model.ts                      Map and verification validation
│   └── shared-server.ts              One-server lifecycle and map tab URLs
├── public/                           Browser UI and renderer
├── maps/native-dsh-web-path/         Bundled clickable presentation
├── templates/map-launcher.command    Launcher template for generated maps
├── scripts/verify.ts                 Essential acceptance gate
└── tests/                             Behavioral test suite
```
