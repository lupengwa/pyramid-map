import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDataStore } from "../src/data-store"
import { createHttpApp } from "../src/http-app"
import { collectNodeIds } from "../src/model"
import { createMapFitTransform, createMapLayout, createMindmapBranchPath, createNodeProofRows, resolveNodeClick, visibleTree } from "../public/map-model.js"

const appRoot = join(import.meta.dir, "..")
const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-gwe-verify-"))
const treePath = join(temporaryRoot, "tree.json")
const verificationPath = join(temporaryRoot, "verification.json")
const activityPath = join(temporaryRoot, "activity.jsonl")

try {
  await writeFile(treePath, await readFile(join(appRoot, "data/tree.json"), "utf8"), "utf8")
  await writeFile(verificationPath, '{"version":1,"updatedAt":null,"verified":{}}\n', "utf8")
  const dataStore = await createDataStore({
    treePath,
    verificationPath,
    activityPath,
  })
  const nodeIds = collectNodeIds(dataStore.getTree())
  assert(nodeIds.size === 22, `Expected 22 proof nodes, found ${nodeIds.size}`)
  console.log("ready: data/tree.json contains one valid 22-node proof tree")

  const app = createHttpApp({
    dataStore,
    publicRoot: join(appRoot, "public"),
  })
  const page = await app(new Request("http://local.test/"))
  assert(page.status === 200, `Expected the HTML route to return 200, received ${page.status}`)
  assert((await page.text()).includes('id="map-viewport"'), "The HTML route is missing the interactive map entrance")
  const treeResponse = await app(new Request("http://local.test/api/tree"))
  assert(treeResponse.status === 200, "The tree API is unavailable")
  const snapshotResponse = await app(new Request("http://local.test/api/map"))
  assert(snapshotResponse.status === 200 && (await snapshotResponse.json()).revision === 0, "The revisioned map API is unavailable")
  const mapModel = await app(new Request("http://local.test/map-model.js"))
  assert(mapModel.status === 200, "The browser map model is unavailable")
  const favicon = await app(new Request("http://local.test/favicon.svg"))
  assert(favicon.status === 200, "The browser favicon is unavailable")
  console.log("ready: the local HTTP app serves its browser entrance, visual assets, map model, and proof API")

  const defaultMap = createMapLayout(visibleTree(dataStore.getTree(), new Set(["G0"]), null))
  const rootChildren = defaultMap.edges
    .filter((edge) => edge.parentId === "G0")
    .map((edge) => edge.childId)
  assert(JSON.stringify(rootChildren) === JSON.stringify(["G1", "G2", "G3", "G4"]), "G0 does not visibly connect to all four direct children")
  console.log("ready: the default map explicitly connects G0 to G1, G2, G3, and G4")

  for (const edge of defaultMap.edges) {
    const branchPath = createMindmapBranchPath(edge)
    assert(branchPath.includes(" C "), `${edge.parentId}->${edge.childId} is not a smooth branch path`)
  }
  console.log("ready: proof relationships use smooth top-down branch paths")

  for (const node of defaultMap.nodes) {
    const proofRows = createNodeProofRows(node)
    assert(proofRows.length === 4, `${node.id} does not expose all four proof rows`)
    assert(proofRows.every((row) => row.html.trim() !== ""), `${node.id} has an empty visible proof row`)
  }
  console.log("ready: both default levels expose Given, When, Expect, and Notes on every card")

  const bodyClick = resolveNodeClick({
    closest(selector: string) {
      return selector === "[data-node-id]" ? { dataset: { nodeId: "G2" } } : null
    },
  })
  assert(bodyClick?.type === "open" && bodyClick.id === "G2", "A click in the card body does not open its node")
  console.log("ready: every card surface opens its detail and action drawer")

  const wideFit = createMapFitTransform({
    layoutWidth: 2028,
    layoutHeight: defaultMap.height,
    viewportWidth: 1175,
    viewportHeight: 640,
    maxSiblingCount: 7,
  })
  assert(wideFit.scale === 0.78 && wideFit.isHorizontallyOverflowing, "Wide fan-out shrinks below the readable card scale")
  console.log("ready: fan-out beyond five children keeps a readable horizontal review window")

  const editableNode = defaultMap.nodes.find((node) => node.id === "G4")
  assert(editableNode !== undefined, "The temporary proof tree is missing G4")
  const updated = await app(new Request("http://local.test/api/tree/G4", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: editableNode.title,
      pattern: editableNode.pattern,
      style: "editorial",
      sections: editableNode.sections.map((section) => section.key === "notes"
        ? { ...section, body: `${section.body} Edited in the verification sandbox.` }
        : section),
      evidence: editableNode.evidence,
      source: editableNode.source,
    }),
  }))
  assert(updated.status === 200, `Expected node update to return 200, received ${updated.status}`)

  const childContent = {
    title: "A temporary authored child persists.",
    given: "The authoring API is available.",
    when: "A child is added in the verification sandbox.",
    expect: "The child receives a generated hierarchical ID.",
    notes: "This node never touches the workspace data file.",
    evidence: "structural",
    source: "scripts/verify.ts",
  }
  const added = await app(new Request("http://local.test/api/tree/G0/children", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(childContent),
  }))
  assert(added.status === 201, `Expected child creation to return 201, received ${added.status}`)
  const addedBody = await added.json()
  assert(addedBody.nodeId === "G5", `Expected the generated root child ID G5, received ${addedBody.nodeId}`)
  const removed = await app(new Request("http://local.test/api/tree/G5", { method: "DELETE" }))
  assert(removed.status === 200, `Expected subtree removal to return 200, received ${removed.status}`)
  assert((await removed.json()).removedIds.includes("G5"), "The remove response did not report its deleted node")
  const humanChanges = await app(new Request("http://local.test/api/changes?since=0&actor=human"))
  const humanChangeBody = await humanChanges.json()
  assert(humanChangeBody.changes.length === 3, "The HTTP API did not expose all three human content edits")
  assert(humanChangeBody.changes.every((change: any) => change.actor === "human"), "A browser edit was not recorded as human")
  console.log("ready: flexible node edits, child creation, subtree removal, and human authorship persist through the HTTP API")

  const marked = await app(new Request("http://local.test/api/verification/G0", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verified: true }),
  }))
  assert(marked.status === 200, `Expected mark request to return 200, received ${marked.status}`)
  const savedFile = JSON.parse(await readFile(verificationPath, "utf8"))
  assert(typeof savedFile.verified.G0?.verifiedAt === "string", "The G0 mark was not written to the verification file")

  const reopenedStore = await createDataStore({
    treePath,
    verificationPath,
    activityPath,
  })
  assert("G0" in reopenedStore.getVerification().verified, "A fresh store did not reopen the saved G0 mark")
  console.log("ready: human marks persist in a separate file and reopen in a fresh store")

  const reopenedApp = createHttpApp({
    dataStore: reopenedStore,
    publicRoot: join(appRoot, "public"),
  })
  const reset = await reopenedApp(new Request("http://local.test/api/verification", { method: "DELETE" }))
  assert(reset.status === 200, `Expected reset request to return 200, received ${reset.status}`)
  const resetFile = JSON.parse(await readFile(verificationPath, "utf8"))
  assert(Object.keys(resetFile.verified).length === 0, "Reset did not empty the verification file")
  assert(typeof resetFile.updatedAt === "string", "Reset did not record its time")
  console.log("ready: reset clears all marks while preserving the verification file")

  console.log("READY: the DSH Web pyramid map can go live")
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
