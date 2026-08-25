# Pyramid Map

Pyramid Map is a local, shared human-agent tool for editing a zoomable, top-down proof tree.
The bundled map demonstrates the native DSH Web path.
GWE plus Notes is the default card pattern, but every node can own a different ordered section pattern and visual style.
The map, human verification state, and human-agent activity history are separate workspace files.
Every verification change is saved on the server before the UI turns green.
Node edits and tree-structure changes are also saved before the canvas updates.

## Start the app

Double-click `Start Pyramid Map.command` in Finder.
The launcher runs the verification gate, starts the local server, and opens the app in the default browser.
It resolves Bun from the terminal path or the standard `~/.bun/bin/bun` installation.
Keep the terminal window open while using the app, then press `Ctrl-C` there to stop it.

For a fresh checkout, use:

```sh
git clone https://github.com/lupengwa/pyramid-map.git
cd pyramid-map
bun install
bun run start
```

The default URL is `http://127.0.0.1:4318`.
Set `DSH_GWE_PORT` when that port is already occupied.
`DSH_GWE_TREE_PATH`, `DSH_GWE_VERIFICATION_PATH`, and `DSH_GWE_ACTIVITY_PATH` can point an isolated test server at temporary data copies.

Opening `public/index.html` directly is not a supported path because a plain browser file cannot write `data/verification.json` safely.

## 1. Load the data files

`server.ts` is the production entry point and the code table of contents.
It first creates the data store in `src/data-store.ts`.

`data/tree.json` owns all card content, presentation tokens, revisions, and parent-child relationships.
The legacy GWE shape remains readable and normalizes to a `gwe-notes` pattern with Proof styling.
The first later mutation writes the revisioned version 2 document shape.
Each normalized node has a unique ID, title, pattern name, style, one to eight ordered sections, evidence, and source.
Section keys are lowercase slugs while labels and bodies are authored per node.
Existing IDs are immutable through the UI.
New child IDs are generated from their parent, such as `G2.5` or `G2.1.1`.
Manually authored text supports plain text and the existing safe `<code>` inline markup only.

`data/verification.json` owns current human verification state.
Marking a node adds its ID and verification timestamp.
Unmarking removes that ID.
Reset empties the verified-node map, preserves the file, and updates its timestamp.

`data/activity.jsonl` is the append-only human-agent change stream.
Every content, structure, and verification mutation records its revision, actor, time, summary, and relevant before/after state.
This history lets an agent distinguish a human clarification from its own earlier edits.

`src/model.ts` owns the file shapes and validates them before the server becomes live.
Unknown IDs in an older verification file are ignored so a changed proof tree can still start safely.

Tree and verification writes use a temporary sibling file followed by an atomic rename.
One in-process queue plus a cross-process lock serializes browser and CLI mutations.
Agent mutations require an expected revision, so a newer human edit causes a conflict instead of being overwritten.
Deleting a node removes its complete subtree and cleans every removed verification mark.
The root G0 cannot be deleted.

## 2. Serve the UI and data API

After the data loads, `server.ts` gives the store to `src/http-app.ts`.
The HTTP app serves the four browser assets and these local endpoints:

- `GET /api/map` reads the latest revision, tree, and verification state.
- `GET /api/tree` reads the proof tree.
- `GET /api/changes?since=:revision&actor=:actor` reads later human or agent activity.
- `PUT /api/tree/:id` edits one node while preserving its ID and children.
- `POST /api/tree/:parentId/children` appends a child with a generated ID.
- `DELETE /api/tree/:id` removes a non-root subtree and its verification marks.
- `GET /api/verification` reads human marks.
- `PUT /api/verification/:id` marks or unmarks one node.
- `DELETE /api/verification` resets all marks.
- `GET /healthz` reports that the server is available.

`public/index.html` owns the conclusion-first page structure.
`public/map-model.js` derives the visible branch set, exposes each node's ordered sections, calculates the top-down node geometry, and emits one smooth top-down branch for every visible parent-child relationship.
`public/app.js` fetches the data sources, renders the map, manages zoom and pan, opens full details, focuses branches, and sends user actions back to the API.
The map model keeps translation on an outer pan layer and magnification on the inner layout, so the browser redraws text at every zoom level instead of enlarging a cached text texture.
`public/styles.css` owns the compact session rail, full proof cards, detail drawer, green verified state, full-screen canvas, and keyboard focus treatment.

The default view expands only G0, so G0 and its four direct children fit together as two complete layers on a MacBook screen.
Every default card shows Given, When, Expect, and Notes directly; its capability title is secondary context.
The editor can rename, reorder, add, and remove sections and select Proof, Editorial, or Signal card styling.
The title and verification chrome use compact single-line bands so the proof content receives most of each card.
Clicking anywhere on a card opens its detail and action drawer; the branch-fold control remains an independent action.
The root starts near the canvas top instead of vertically centering unused pyramid space.
Each child reports its hidden descendant count and can expand independently.
Each first-level proof branch has a stable color inherited by its descendants, while green remains reserved for human verification.
Fold counts sit on the outgoing branch junction, and newly revealed branches draw outward without scaling the card text.
When one node has more than five children, the children remain in one truthful sibling band at readable card width.
The canvas presents a five-card window with a horizontal-pan hint instead of wrapping children into a misleading second hierarchy level or shrinking their proof text.
`Expand all` shows the complete 22-node topology, while `Overview` restores G0 and its four direct children.

Clicking anywhere on a node card opens the larger reading view with evidence, source entrance, and proof-relationship context in the detail drawer.
The drawer also owns verification, child expansion, and branch focus actions.
`Edit node` opens the full proof editor with the current raw text preserved.
`Add child` uses the same editor and previews the generated child ID.
`Remove node` requires confirmation and states how many descendants will also be removed.

Drag or use a trackpad to pan.
Pinch, the `+` and `-` buttons, or the matching keyboard keys change zoom.
`0` fits the visible map, `F` focuses the selected branch, `E` expands or collapses it, and the arrow keys move selection geometrically.

The browser never treats evidence badges as human verification.
A parent never turns green merely because its children are green.

## 3. Use the agent path

`bin/pyramid-map` is the stable agent boundary used by the `pyramid-html` skill.
It always opens the data files again, so each invocation reads the latest browser edits.
Its stdout is TOON and its mutation input accepts JSON or a `.toon` file.

Read the concise map or one complete node:

```sh
bun run map
bun run map view G2 --full
```

When continuing work, inspect human edits after the last revision the agent understood:

```sh
bun run map changes --since 12 --actor human --full
```

Update only from the revision just read:

```sh
bun run map update G2 --input /tmp/g2-edit.json --expected-revision 14
bun run map add-child G2 --input /tmp/new-child.json --expected-revision 15
bun run map remove G2.5 --confirm G2.5 --expected-revision 16
```

Each input supplies `title`, `pattern`, `style`, ordered `sections`, `evidence`, and `source`.
If a human changes the map after the agent reads it, the mutation fails with a revision conflict.
The agent then reads the latest map and human activity before rebuilding its proposed edit.

## 4. Publish the local app URL

Once the server is listening, `server.ts` prints the local URL.
The normal `bun run start` path passes `--open`, so the production entry opens that URL in the default browser.
The server binds only to `127.0.0.1` and is not exposed to the local network.

## 5. Verify before going live

Run:

```sh
bun run verify
```

The gate validates the legacy and flexible tree schemas, proves that G0 emits four explicit smooth child branches, checks that both default levels expose all four default proof rows, serves the real browser assets, edits a styled node, creates and removes a child, records human activity, writes a mark to temporary data files, reopens those files as a fresh store, and resets verification.
It does not modify `data/verification.json`.
It also does not modify `data/tree.json` because every mutation check runs against a temporary copy.

`bun run start` always runs this gate before launching the server.
If an essential check fails, the browser app does not start.

## File map

```text
pyramid-map/
├── Start Pyramid Map.command Double-click launcher
├── server.ts               Production entry and flow map
├── bin/
│   └── pyramid-map         TOON CLI for latest reads and revision-safe agent edits
├── src/
│   ├── cli.ts              Agent command interface and compact/full projections
│   ├── data-store.ts       Revisioned browser/agent mutation seam and activity log
│   ├── http-app.ts         Browser assets and local map API
│   └── model.ts            Flexible card and verification validation
├── data/
│   ├── tree.json           Proof definition
│   ├── verification.json   Human-owned verification state
│   └── activity.jsonl      Append-only human-agent mutation history
├── public/
│   ├── index.html          Conclusion-first document structure
│   ├── map-model.js        Visible proof rows, geometry, and explicit edges
│   ├── app.js              Canvas interaction, details, focus, and user actions
│   ├── styles.css          Compact nodes, full-screen map, editor, and drawer
│   └── favicon.svg         Local browser identity
├── scripts/verify.ts       Essential acceptance gate
└── tests/
    ├── model.test.ts       Focused data-schema checks
    ├── data-store.test.ts  Durable edit, add, remove, and markup-safety checks
    ├── cli.test.ts         TOON output, human-diff, and revision-conflict checks
    ├── map-model.test.ts   Proof-card, parent-child, and branch-focus checks
    └── map-surface.test.ts Zoom rendering ownership checks
```
