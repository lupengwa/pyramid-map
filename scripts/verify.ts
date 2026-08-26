import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDataStore } from "../src/data-store"
import { createHttpApp } from "../src/http-app"
import { compareMaps } from "../src/map-diff"
import { collectNodeIds, parseMapDocument } from "../src/model"
import { readRuntimeIdentity } from "../src/runtime-identity"
import { createMapFitTransform, createMapLayout, createMindmapBranchPath, createNodeProofRows, resolveNodeClick, visibleTree } from "../public/map-model.js"

const appRoot = join(import.meta.dir, "..")
const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-gwe-verify-"))
const treePath = join(temporaryRoot, "tree.json")
const verificationPath = join(temporaryRoot, "verification.json")
const agentValidationPath = join(temporaryRoot, "agent-validation.json")
const agentBasePath = join(temporaryRoot, ".pyramid-map", "agent-base.json")
const runtimeIdentity = await readRuntimeIdentity(appRoot)

try {
  const bundledTree = await readFile(join(appRoot, "maps/native-dsh-web-path/tree.json"), "utf8")
  await mkdir(join(temporaryRoot, ".pyramid-map"))
  await writeFile(treePath, bundledTree, "utf8")
  await writeFile(agentBasePath, bundledTree, "utf8")
  await writeFile(verificationPath, '{"version":2,"updatedAt":null,"reviews":{}}\n', "utf8")
  await writeFile(agentValidationPath, JSON.stringify({
    version: 1,
    treeRevision: 0,
    updatedAt: "2026-08-25T00:00:00.000Z",
    command: "bun run verify",
    validations: {
      G0: { status: "passed", description: "The root acceptance path passed.", locations: ["scripts/verify.ts:1"] },
    },
  }), "utf8")
  const dataStore = await createDataStore({
    treePath,
    verificationPath,
    agentValidationPath,
  })
  const nodeIds = collectNodeIds(dataStore.getTree())
  assert(nodeIds.size === 22, `Expected 22 proof nodes, found ${nodeIds.size}`)
  console.log("ready: the bundled presentation contains one valid 22-node proof tree and matching agent baseline")

  const app = createHttpApp({
    getDataStore: async () => dataStore,
    publicRoot: join(appRoot, "public"),
    runtimeIdentity,
  })
  const page = await app(new Request("http://local.test/"))
  assert(page.status === 200, `Expected the HTML route to return 200, received ${page.status}`)
  const pageSource = await page.text()
  assert(pageSource.includes('id="map-viewport"'), "The HTML route is missing the interactive map entrance")
  assert(pageSource.includes('id="map-name"') && pageSource.includes('id="map-answer"'), "The HTML route cannot identify different map tabs")
  assert(pageSource.includes('<option value="mental-model">Mental model</option>'), "The editor cannot preserve the mental-model card style")
  assert(pageSource.includes('id="editor-relationship"'), "The editor cannot author a child-to-parent relationship")
  assert(pageSource.includes('id="dialog-relationship-panel"') && pageSource.includes('id="evidence-title">Evidence</h3>'), "The detail view does not separate the parent relationship from evidence")
  assert(pageSource.includes('id="human-validation-title"') && pageSource.includes('id="agent-validation-title"'), "The detail view does not separate human judgment from reproducible agent tests")
  assert(!pageSource.includes("Proof context"), "The detail view still labels structural relationships as proof context")
  const health = await app(new Request("http://local.test/healthz"))
  const healthBody = await health.json()
  assert(health.status === 200 && healthBody.app === "pyramid-map", "The shared-server health identity is unavailable")
  assert(healthBody.appRoot === runtimeIdentity.appRoot && healthBody.runtimeFingerprint === runtimeIdentity.fingerprint, "The shared-server health identity omits its runtime fingerprint")
  const treeResponse = await app(new Request("http://local.test/api/tree"))
  assert(treeResponse.status === 200, "The tree API is unavailable")
  const snapshotResponse = await app(new Request("http://local.test/api/map"))
  const initialSnapshot = await snapshotResponse.json()
  assert(snapshotResponse.status === 200 && initialSnapshot.revision === 0, "The revisioned map API is unavailable")
  assert(initialSnapshot.agentValidation.validations.G0.status === "passed", "The map snapshot omits generated agent-test evidence")
  const mapModel = await app(new Request("http://local.test/map-model.js"))
  assert(mapModel.status === 200, "The browser map model is unavailable")
  const favicon = await app(new Request("http://local.test/favicon.svg"))
  assert(favicon.status === 200, "The browser favicon is unavailable")
  const styles = await readFile(join(appRoot, "public/styles.css"), "utf8")
  const appSource = await readFile(join(appRoot, "public/app.js"), "utf8")
  assert(styles.includes(".map-node.card-style-mental-model"), "The mental-model card has no visual treatment")
  assert(styles.includes(".node-relationship") && appSource.includes('class="node-relationship"'), "Child cards do not expose their relationship to the parent")
  assert(styles.includes(".detail-relationship") && appSource.includes("relationshipPanel.hidden = parentId === null"), "Child details do not promote the parent relationship near the top")
  assert(styles.includes(".human-validated") && styles.includes(".human-impossible"), "Human validated and impossible outcomes are not visually distinct")
  assert(styles.includes(".agent-passed") && styles.includes(".agent-failed") && styles.includes(".agent-stale"), "Agent test outcomes are not visually distinct")
  assert(appSource.includes("createValidationPresentation") && appSource.includes("dialog-agent-locations"), "Cards do not render independent human and agent-test status with test locations")
  assert(styles.includes("overflow-wrap: anywhere") && styles.includes("white-space: normal"), "Node titles can still be visually truncated")
  console.log("ready: the local HTTP app identifies the shared server and serves map-specific browser and proof surfaces")
  console.log("ready: full node titles wrap and mental-model cards expose their first section at a glance")
  console.log("ready: every child detail promotes its parent relationship above node sections and keeps evidence separate")

  const launcher = await readFile(join(appRoot, "templates/map-launcher.command"), "utf8")
  assert(launcher.includes('bin/pyramid-map --map "$MAP_DIRECTORY" open'), "Generated launchers do not use the shared-server open path")
  assert(!launcher.includes("server.ts --map"), "Generated launchers still bind one server per map")
  console.log("ready: every generated launcher reuses one server and opens its destination as a separate tab")

  const defaultMap = createMapLayout(visibleTree(dataStore.getTree(), new Set(["G0"]), null))
  const rootChildren = defaultMap.edges
    .filter((edge) => edge.parentId === "G0")
    .map((edge) => edge.childId)
  assert(JSON.stringify(rootChildren) === JSON.stringify(["G1", "G2", "G3", "G4"]), "G0 does not visibly connect to all four direct children")
  assert(defaultMap.nodes.slice(1).every((node) => typeof node.relationship === "string" && node.relationship.length > 0), "A visible child is missing its authored parent relationship")
  console.log("ready: the default map explicitly connects G0 to G1, G2, G3, and G4")
  console.log("ready: every visible child states its concise contribution to the parent")

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
      relationship: editableNode.relationship,
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
    relationship: "This gives G0 a temporary capability for the authoring check.",
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
  const humanComparison = await compareFiles(agentBasePath, treePath)
  assert(!humanComparison.inSync, "The agent baseline did not expose the browser-authored map difference")
  assert(humanComparison.differences.some((difference) => difference.type === "update" && difference.nodeId === "G4"), "The semantic diff missed the browser-authored G4 update")
  console.log("ready: browser edits change tree.json while agent-base.json preserves the prior accepted map")

  const acceptedTree = await readFile(treePath, "utf8")
  await writeFile(agentBasePath, acceptedTree, "utf8")
  assert((await compareFiles(agentBasePath, treePath)).inSync, "An agent-authored map did not return tree.json and agent-base.json to the same state")
  console.log("ready: an agent can accept its completed map by writing identical JSON to current and baseline files")

  const marked = await app(new Request("http://local.test/api/verification/G0", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "impossible", description: "The human confirmed that this Expect cannot hold as written." }),
  }))
  assert(marked.status === 200, `Expected mark request to return 200, received ${marked.status}`)
  const savedFile = JSON.parse(await readFile(verificationPath, "utf8"))
  assert(savedFile.reviews.G0?.status === "impossible", "The G0 human outcome was not written to the verification file")
  assert(savedFile.reviews.G0?.description.includes("cannot hold"), "The G0 human description was not written to the verification file")

  const reopenedStore = await createDataStore({
    treePath,
    verificationPath,
    agentValidationPath,
  })
  assert(reopenedStore.getVerification().reviews.G0?.status === "impossible", "A fresh store did not reopen the saved G0 human outcome")
  assert(reopenedStore.getAgentValidation().validations.G0?.status === "passed", "A fresh store did not reopen the generated agent-test result")
  console.log("ready: human outcomes and generated agent-test evidence persist independently and reopen in a fresh store")

  const reopenedApp = createHttpApp({
    getDataStore: async () => reopenedStore,
    publicRoot: join(appRoot, "public"),
    runtimeIdentity,
  })
  const reset = await reopenedApp(new Request("http://local.test/api/verification", { method: "DELETE" }))
  assert(reset.status === 200, `Expected reset request to return 200, received ${reset.status}`)
  const resetFile = JSON.parse(await readFile(verificationPath, "utf8"))
  assert(Object.keys(resetFile.reviews).length === 0, "Reset did not empty the verification file")
  assert(typeof resetFile.updatedAt === "string", "Reset did not record its time")
  console.log("ready: reset clears all marks while preserving the verification file")

  console.log("READY: Pyramid Map can go live")
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function compareFiles(basePath: string, currentPath: string) {
  const [base, current] = await Promise.all([readFile(basePath, "utf8"), readFile(currentPath, "utf8")])
  return compareMaps(parseMapDocument(JSON.parse(base)).root, parseMapDocument(JSON.parse(current)).root)
}
