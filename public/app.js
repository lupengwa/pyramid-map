import { createMapFitTransform, createMapLayout, createMapSurfacePresentation, createMindmapBranchPath, createNodeProofRows, indexTree, resolveNodeClick, visibleTree } from "./map-model.js"

const viewportElement = document.querySelector("#map-viewport")
const panLayerElement = document.querySelector("#map-pan-layer")
const sceneElement = document.querySelector("#map-scene")
const edgesElement = document.querySelector("#map-edges")
const nodesElement = document.querySelector("#map-nodes")
const countLabel = document.querySelector("#verification-count")
const saveStatus = document.querySelector("#save-status")
const resetButton = document.querySelector("#reset-verification")
const appMessage = document.querySelector("#app-message")
const announcement = document.querySelector("#verification-announcement")
const zoomLevel = document.querySelector("#zoom-level")
const focusContext = document.querySelector("#focus-context")
const focusLabel = document.querySelector("#focus-label")
const canvasHint = document.querySelector("#canvas-hint")

const nodeDialog = document.querySelector("#node-dialog")
const editorDialog = document.querySelector("#node-editor-dialog")
const editorForm = document.querySelector("#node-editor-form")
const deleteDialog = document.querySelector("#delete-dialog")
const resetDialog = document.querySelector("#reset-dialog")

const evidenceNames = {
  structural: "Structural",
  source: "Source traced",
  e2e: "Recorded E2E path",
}

const branchColors = ["#2f7e91", "#b9792e", "#7463a8", "#b65358", "#5c7c3f"]

const transform = { x: 0, y: 0, scale: 1 }
const expandedIds = new Set(["G0"])
let proofTree
let treeIndex
let currentLayout
let verification = emptyVerification()
let focusId = null
let selectedId = null
let saveInProgress = false
let dragState = null
let transformFrame = null
let renderedEdgeIds = new Set()
let editorMode = null
let editorTargetId = null
let pendingDeleteId = null
let lastTreeSave = null

await loadApp()

async function loadApp() {
  setMessage("")
  viewportElement.setAttribute("aria-busy", "true")
  try {
    const [tree, savedVerification] = await Promise.all([
      requestJson("/api/tree"),
      requestJson("/api/verification"),
    ])
    proofTree = tree
    treeIndex = indexTree(tree)
    verification = savedVerification
    selectedId = tree.id
    renderMap({ fit: true })
    renderSaveState()
  } catch (error) {
    showFailure(error, "The proof app could not load its data files.")
  } finally {
    viewportElement.setAttribute("aria-busy", "false")
  }
}

function renderMap({ fit = false } = {}) {
  const visible = visibleTree(proofTree, expandedIds, focusId)
  currentLayout = createMapLayout(visible)
  if (!currentLayout.nodes.some((node) => node.id === selectedId)) selectedId = visible.id

  sceneElement.style.width = `${currentLayout.width}px`
  sceneElement.style.height = `${currentLayout.height}px`
  edgesElement.setAttribute("viewBox", `0 0 ${currentLayout.width} ${currentLayout.height}`)
  edgesElement.setAttribute("width", String(currentLayout.width))
  edgesElement.setAttribute("height", String(currentLayout.height))
  const nextEdgeIds = new Set(currentLayout.edges.map(edgeId))
  edgesElement.innerHTML = currentLayout.edges
    .map((edge) => edgeMarkup(edge, !renderedEdgeIds.has(edgeId(edge))))
    .join("")
  renderedEdgeIds = nextEdgeIds
  nodesElement.innerHTML = currentLayout.nodes.map(nodeMarkup).join("")

  renderFocusContext()
  renderSaveState()
  if (fit) requestAnimationFrame(fitMap)
}

function edgeMarkup(edge, isEntering) {
  const path = createMindmapBranchPath(edge)
  const classes = `map-edge${isEntering ? " is-entering" : ""}`
  return `<path class="${classes}" data-parent-id="${edge.parentId}" data-child-id="${edge.childId}" d="${path}" pathLength="1" style="--branch-color:${branchColorFor(edge.childId)}" />`
}

function nodeMarkup(node) {
  const childCount = treeIndex.nodes.get(node.id).children?.length ?? 0
  const isExpanded = expandedIds.has(node.id)
  const isVerified = node.id in verification.verified
  const classes = [
    "map-node",
    `card-style-${node.style ?? "proof"}`,
    node.id === (focusId ?? proofTree.id) ? "map-node-root" : "",
    isVerified ? "is-verified" : "",
    node.id === selectedId ? "is-selected" : "",
  ].filter(Boolean).join(" ")
  const proofRows = createNodeProofRows(node)
    .map((row) => `<div data-proof-field="${row.key}"><dt>${row.label}</dt><dd>${row.html}</dd></div>`)
    .join("")

  return `
    <article class="${classes}" id="${domId(node.id)}" data-node-id="${node.id}" style="--branch-color:${branchColorFor(node.id)};left:${node.x - node.width / 2}px;top:${node.y}px;width:${node.width}px;height:${node.height}px">
      <button class="node-open" type="button" data-open-node="${node.id}" aria-label="Open ${node.id}: ${plainText(node.title)}">
        <span class="node-kicker"><span class="verification-dot" aria-hidden="true"></span>${node.id}</span>
        <span class="node-title">${node.title}</span>
      </button>
      <dl class="node-gwe" aria-label="${node.id} proof">
        ${proofRows}
      </dl>
      <footer class="node-footer">
        <span>${isVerified ? "Human verified" : "Not verified"}</span>
        ${childCount === 0 ? "" : `<button class="child-toggle" type="button" data-toggle-node="${node.id}" aria-label="${isExpanded ? "Collapse" : "Show"} ${childCount} children of ${node.id}" aria-expanded="${isExpanded}">${isExpanded ? "−" : "+"}${childCount}</button>`}
      </footer>
    </article>
  `
}

function edgeId(edge) {
  return `${edge.parentId}->${edge.childId}`
}

function branchColorFor(id) {
  if (id === proofTree.id) return "#236951"

  let branchId = id
  let parentId = treeIndex.parents.get(branchId)
  while (parentId !== null && parentId !== proofTree.id) {
    branchId = parentId
    parentId = treeIndex.parents.get(branchId)
  }

  const branchIndex = (proofTree.children ?? []).findIndex((child) => child.id === branchId)
  return branchColors[Math.max(branchIndex, 0) % branchColors.length]
}

function fitMap() {
  if (currentLayout === undefined) return
  const viewport = viewportElement.getBoundingClientRect()
  const fitted = createMapFitTransform({
    layoutWidth: currentLayout.width,
    layoutHeight: currentLayout.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    maxSiblingCount: currentLayout.maxSiblingCount,
  })
  transform.scale = fitted.scale
  transform.x = fitted.x
  transform.y = fitted.y
  applyTransform()
}

function zoomBy(factor, clientX, clientY) {
  const viewport = viewportElement.getBoundingClientRect()
  const anchorX = clientX === undefined ? viewport.width / 2 : clientX - viewport.left
  const anchorY = clientY === undefined ? viewport.height / 2 : clientY - viewport.top
  const nextScale = clamp(transform.scale * factor, 0.18, 2.2)
  const ratio = nextScale / transform.scale
  transform.x = anchorX - (anchorX - transform.x) * ratio
  transform.y = anchorY - (anchorY - transform.y) * ratio
  transform.scale = nextScale
  scheduleTransform()
}

function applyTransform() {
  const presentation = createMapSurfacePresentation(transform)
  panLayerElement.style.transform = presentation.panTransform
  sceneElement.style.zoom = presentation.sceneZoom
  zoomLevel.value = `${Math.round(transform.scale * 100)}%`
  zoomLevel.textContent = zoomLevel.value
  renderCanvasHint()
}

function renderCanvasHint() {
  if (currentLayout === undefined) return
  const viewportWidth = viewportElement.getBoundingClientRect().width
  const needsHorizontalReview = currentLayout.maxSiblingCount > 5
    && currentLayout.width * transform.scale > viewportWidth - 24
  canvasHint.hidden = !needsHorizontalReview
  if (needsHorizontalReview) {
    canvasHint.textContent = `${currentLayout.maxSiblingCount} sibling cards · drag horizontally to review all`
  }
}

function scheduleTransform() {
  if (transformFrame !== null) return
  transformFrame = requestAnimationFrame(() => {
    transformFrame = null
    applyTransform()
  })
}

function toggleChildren(id) {
  const node = treeIndex.nodes.get(id)
  if ((node.children?.length ?? 0) === 0) return
  if (expandedIds.has(id)) expandedIds.delete(id)
  else expandedIds.add(id)
  renderMap({ fit: true })
  if (nodeDialog.open && selectedId === id) renderDialog(id)
}

function expandAll() {
  for (const node of treeIndex.nodes.values()) {
    if ((node.children?.length ?? 0) > 0) expandedIds.add(node.id)
  }
  renderMap({ fit: true })
}

function collapseToFirstLevel() {
  expandedIds.clear()
  expandedIds.add(focusId ?? proofTree.id)
  renderMap({ fit: true })
}

function focusBranch(id) {
  const node = treeIndex.nodes.get(id)
  if (node === undefined) return
  focusId = id === proofTree.id ? null : id
  if ((node.children?.length ?? 0) > 0) expandedIds.add(id)
  selectedId = id
  if (nodeDialog.open) nodeDialog.close()
  renderMap({ fit: true })
  announce(`${id} is now the focused proof branch`)
}

function showFullTree() {
  focusId = null
  selectedId = proofTree.id
  expandedIds.add(proofTree.id)
  renderMap({ fit: true })
  announce("The full proof tree is visible")
}

function renderFocusContext() {
  focusContext.hidden = focusId === null
  if (focusId === null) return
  const node = treeIndex.nodes.get(focusId)
  focusLabel.textContent = `Focused: ${node.id} · ${plainText(node.title)}`
}

function openDialog(id) {
  selectedId = id
  renderMap()
  renderDialog(id)
  if (!nodeDialog.open) nodeDialog.showModal()
}

function renderDialog(id) {
  const node = treeIndex.nodes.get(id)
  const parentId = treeIndex.parents.get(id)
  const childIds = (node.children ?? []).map((child) => child.id)
  const isVerified = id in verification.verified

  document.querySelector("#dialog-id").textContent = `${id} · capability proof`
  document.querySelector("#dialog-title").innerHTML = node.title
  document.querySelector("#dialog-path").textContent = proofPath(id).join("  /  ")
  document.querySelector("#dialog-sections").innerHTML = createNodeProofRows(node)
    .map((section) => `<div data-detail-section="${section.key}"><dt>${section.label}</dt><dd>${section.html}</dd></div>`)
    .join("")
  document.querySelector("#dialog-relationship").textContent = relationshipText(id, parentId, childIds)

  const badge = document.querySelector("#dialog-evidence")
  badge.className = `badge ${node.evidence}`
  badge.textContent = evidenceNames[node.evidence]
  document.querySelector("#dialog-source").textContent = node.source

  const verifyButton = document.querySelector("#dialog-verify")
  verifyButton.textContent = isVerified ? "Verified by me" : "Mark human verified"
  verifyButton.classList.toggle("is-verified", isVerified)
  verifyButton.disabled = saveInProgress
  verifyButton.dataset.verifyNode = id

  const toggleButton = document.querySelector("#dialog-toggle-children")
  toggleButton.hidden = childIds.length === 0
  toggleButton.textContent = expandedIds.has(id) ? `Collapse ${childIds.length} children` : `Show ${childIds.length} children`
  toggleButton.dataset.toggleNode = id

  const focusButton = document.querySelector("#dialog-focus")
  focusButton.textContent = focusId === id || (focusId === null && id === proofTree.id) ? "Fit this branch" : "Focus branch"
  focusButton.dataset.focusNode = id

  document.querySelector("#dialog-edit").dataset.editNode = id
  document.querySelector("#dialog-add-child").dataset.addChild = id
  const removeButton = document.querySelector("#dialog-remove-node")
  removeButton.hidden = parentId === null
  removeButton.dataset.removeNode = id
}

function openNodeEditor(mode, id) {
  const node = treeIndex.nodes.get(id)
  if (node === undefined) return
  editorMode = mode
  editorTargetId = id
  document.querySelector("#editor-mode").textContent = mode === "edit" ? "Edit existing node" : `Add child to ${id}`
  document.querySelector("#editor-title").textContent = mode === "edit" ? "Edit capability proof" : "Add child capability"
  document.querySelector("#editor-node-id").textContent = mode === "edit" ? id : `${nextChildIdFor(node)} · generated when saved`
  document.querySelector("#editor-node-title").value = mode === "edit" ? node.title : ""
  document.querySelector("#editor-pattern").value = mode === "edit" ? node.pattern : "gwe-notes"
  document.querySelector("#editor-style").value = mode === "edit" ? node.style : "proof"
  document.querySelector("#editor-evidence").value = mode === "edit" ? node.evidence : "structural"
  document.querySelector("#editor-source").value = mode === "edit" ? node.source : "manual"
  renderEditorSections(mode === "edit" ? node.sections : defaultProofSections())
  setEditorError("")
  nodeDialog.close()
  editorDialog.showModal()
  document.querySelector("#editor-node-title").focus()
}

function nextChildIdFor(parent) {
  const prefix = parent.id === proofTree.id ? "G" : `${parent.id}.`
  const siblingNumbers = (parent.children ?? [])
    .map((child) => child.id.startsWith(prefix) ? Number(child.id.slice(prefix.length)) : Number.NaN)
    .filter((value) => Number.isInteger(value) && value > 0)
  return `${prefix}${Math.max(0, ...siblingNumbers) + 1}`
}

async function saveNodeEditor() {
  if (editorTargetId === null || editorMode === null) return
  const content = {
    ...Object.fromEntries(new FormData(editorForm)),
    sections: [...document.querySelectorAll(".editor-section")].map((section) => ({
      key: section.querySelector("[data-section-key]").value,
      label: section.querySelector("[data-section-label]").value,
      body: section.querySelector("[data-section-body]").value,
    })),
  }
  const parentId = editorTargetId
  const isAdding = editorMode === "add"
  lastTreeSave = null
  setTreeSaving(true)
  setEditorError("")

  try {
    const result = await requestJson(
      isAdding
        ? `/api/tree/${encodeURIComponent(parentId)}/children`
        : `/api/tree/${encodeURIComponent(editorTargetId)}`,
      {
        method: isAdding ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(content),
      },
    )
    applyTreeState(result)
    if (isAdding) expandedIds.add(parentId)
    const savedId = isAdding ? result.nodeId : editorTargetId
    selectedId = savedId
    lastTreeSave = `Tree saved ${currentTimeLabel()}`
    editorDialog.close()
    renderMap({ fit: true })
    openDialog(savedId)
    announce(`${savedId} ${isAdding ? "added" : "updated"} and saved to data/tree.json`)
  } catch (error) {
    setEditorError(error instanceof Error ? error.message : "The node could not be saved")
    showFailure(error, "data/tree.json was not changed.")
  } finally {
    setTreeSaving(false)
    if (nodeDialog.open) renderDialog(selectedId)
  }
}

function openDeleteDialog(id) {
  const node = treeIndex.nodes.get(id)
  if (node === undefined || id === proofTree.id) return
  const subtreeSize = countSubtree(node)
  pendingDeleteId = id
  deleteDialog.returnValue = ""
  document.querySelector("#delete-title").textContent = `Remove ${id}?`
  document.querySelector("#delete-message").textContent = subtreeSize === 1
    ? `${id} will be removed from its parent. This cannot be undone from the app.`
    : `${id} and its ${subtreeSize - 1} descendants will be removed. Their verification marks will also be deleted. This cannot be undone from the app.`
  nodeDialog.close()
  deleteDialog.showModal()
}

async function deletePendingNode() {
  if (pendingDeleteId === null) return
  const id = pendingDeleteId
  lastTreeSave = null
  setTreeSaving(true)
  try {
    const result = await requestJson(`/api/tree/${encodeURIComponent(id)}`, { method: "DELETE" })
    for (const removedId of result.removedIds) expandedIds.delete(removedId)
    if (focusId !== null && result.removedIds.includes(focusId)) focusId = null
    applyTreeState(result)
    selectedId = result.parentId
    lastTreeSave = `Tree saved ${currentTimeLabel()}`
    pendingDeleteId = null
    renderMap({ fit: true })
    openDialog(result.parentId)
    announce(`${result.removedIds.length} proof node${result.removedIds.length === 1 ? "" : "s"} removed`)
  } catch (error) {
    showFailure(error, "The proof subtree was not removed.")
    if (treeIndex.nodes.has(id)) openDialog(id)
  } finally {
    setTreeSaving(false)
    if (nodeDialog.open) renderDialog(selectedId)
  }
}

function applyTreeState(result) {
  proofTree = result.tree
  verification = result.verification
  treeIndex = indexTree(proofTree)
}

function countSubtree(node) {
  return 1 + (node.children ?? []).reduce((total, child) => total + countSubtree(child), 0)
}

function defaultProofSections() {
  return [
    { key: "given", label: "Given", body: "" },
    { key: "when", label: "When", body: "" },
    { key: "expect", label: "Expect", body: "" },
    { key: "notes", label: "Notes", body: "" },
  ]
}

function renderEditorSections(sections) {
  const container = document.querySelector("#editor-sections")
  container.replaceChildren(...sections.map(createEditorSection))
  updateSectionControls()
}

function createEditorSection(section) {
  const wrapper = document.createElement("section")
  wrapper.className = "editor-section"

  const heading = document.createElement("div")
  heading.className = "editor-section-heading"

  const keyInput = document.createElement("input")
  keyInput.dataset.sectionKey = ""
  keyInput.value = section.key
  keyInput.required = true
  keyInput.pattern = "[a-z][a-z0-9-]*"
  keyInput.setAttribute("aria-label", "Section key")
  keyInput.placeholder = "section-key"

  const labelInput = document.createElement("input")
  labelInput.dataset.sectionLabel = ""
  labelInput.value = section.label
  labelInput.required = true
  labelInput.setAttribute("aria-label", "Section label")
  labelInput.placeholder = "Visible label"

  const controls = document.createElement("span")
  controls.className = "editor-section-controls"
  controls.innerHTML = `
    <button type="button" data-move-section="up" aria-label="Move section up">↑</button>
    <button type="button" data-move-section="down" aria-label="Move section down">↓</button>
    <button type="button" data-remove-section aria-label="Remove section">×</button>
  `

  const body = document.createElement("textarea")
  body.dataset.sectionBody = ""
  body.value = section.body
  body.required = true
  body.rows = 4
  body.setAttribute("aria-label", `${section.label || "Section"} body`)
  body.placeholder = "Section content"

  heading.append(keyInput, labelInput, controls)
  wrapper.append(heading, body)
  return wrapper
}

function updateSectionControls() {
  const sections = [...document.querySelectorAll(".editor-section")]
  for (const [index, section] of sections.entries()) {
    section.querySelector('[data-move-section="up"]').disabled = index === 0
    section.querySelector('[data-move-section="down"]').disabled = index === sections.length - 1
    section.querySelector("[data-remove-section]").disabled = sections.length === 1
  }
  document.querySelector("#add-editor-section").disabled = sections.length >= 8
}

function setTreeSaving(isSaving) {
  saveInProgress = isSaving
  document.querySelector("#save-node").disabled = isSaving
  document.querySelector("#cancel-editor").disabled = isSaving
  if (isSaving) saveStatus.textContent = "Saving to data/tree.json"
  else renderSaveState()
}

function setEditorError(message) {
  const errorElement = document.querySelector("#editor-error")
  errorElement.hidden = message === ""
  errorElement.textContent = message
}

function relationshipText(id, parentId, childIds) {
  if (parentId === null) {
    return `${id} is the root. Its conclusion is supported by ${childIds.join(", ")}. The root still requires independent human verification.`
  }
  const childFact = childIds.length === 0
    ? "This is a leaf proof."
    : `Its claim receives supporting facts from ${childIds.join(", ")}.`
  return `${childFact} When ${id}'s stated result holds, that fact supports ${parentId}. Neither direction automatically marks another node verified.`
}

function proofPath(id) {
  const path = []
  let currentId = id
  while (currentId !== null) {
    path.unshift(currentId)
    currentId = treeIndex.parents.get(currentId)
  }
  return path
}

async function toggleVerification(id) {
  const isVerified = !(id in verification.verified)
  await saveAction(
    () => requestJson(`/api/verification/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verified: isVerified }),
    }),
    `${id} ${isVerified ? "marked verified by you" : "is no longer marked verified"}`,
  )
}

async function resetVerification() {
  if (Object.keys(verification.verified).length === 0) return
  await saveAction(
    () => requestJson("/api/verification", { method: "DELETE" }),
    "All human verification marks were reset",
  )
}

async function saveAction(action, successMessage) {
  saveInProgress = true
  saveStatus.textContent = "Saving to data/verification.json"
  setMessage("")
  renderSaveState()
  if (nodeDialog.open) renderDialog(selectedId)
  try {
    verification = await action()
    announce(successMessage)
    renderMap()
    if (nodeDialog.open) renderDialog(selectedId)
  } catch (error) {
    showFailure(error, "The verification file was not changed.")
  } finally {
    saveInProgress = false
    renderSaveState()
    if (nodeDialog.open) renderDialog(selectedId)
  }
}

function renderSaveState() {
  const verifiedCount = Object.keys(verification.verified).length
  countLabel.textContent = `${verifiedCount} of ${treeIndex?.nodes.size ?? 0} verified`
  resetButton.disabled = verifiedCount === 0 || saveInProgress
  if (saveInProgress) return
  if (lastTreeSave !== null) {
    saveStatus.textContent = lastTreeSave
    return
  }
  if (verification.updatedAt === null) {
    saveStatus.textContent = "Ready · file-backed"
    return
  }
  const savedAt = new Date(verification.updatedAt)
  saveStatus.textContent = `Saved ${savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
}

function currentTimeLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

async function requestJson(path, options) {
  const response = await fetch(path, options)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`)
  return body
}

function showFailure(error, fallbackMessage) {
  console.error(error)
  saveStatus.textContent = "Not saved"
  setMessage(`${fallbackMessage} ${error instanceof Error ? error.message : "Unknown error"}`)
}

function setMessage(message) {
  appMessage.hidden = message === ""
  appMessage.textContent = message
}

function announce(message) {
  announcement.textContent = ""
  requestAnimationFrame(() => { announcement.textContent = message })
}

function selectNearest(direction) {
  const current = currentLayout.nodes.find((node) => node.id === selectedId) ?? currentLayout.nodes[0]
  const candidates = currentLayout.nodes.filter((node) => {
    if (node.id === current.id) return false
    if (direction === "left") return node.x < current.x
    if (direction === "right") return node.x > current.x
    if (direction === "up") return node.y < current.y
    return node.y > current.y
  })
  if (candidates.length === 0) return

  const horizontal = direction === "left" || direction === "right"
  candidates.sort((a, b) => directionScore(a, current, horizontal) - directionScore(b, current, horizontal))
  selectedId = candidates[0].id
  renderMap()
  nodesElement.querySelector(`[data-open-node="${cssEscape(selectedId)}"]`)?.focus({ preventScroll: true })
}

function directionScore(candidate, current, horizontal) {
  const primary = horizontal ? Math.abs(candidate.x - current.x) : Math.abs(candidate.y - current.y)
  const secondary = horizontal ? Math.abs(candidate.y - current.y) : Math.abs(candidate.x - current.x)
  return primary + secondary * 0.35
}

function plainText(html) {
  const template = document.createElement("template")
  template.innerHTML = html
  return template.content.textContent.trim()
}

function domId(id) {
  return `map-node-${id.toLowerCase().replaceAll(".", "-")}`
}

function cssEscape(value) {
  return CSS.escape(value)
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

function emptyVerification() {
  return { version: 1, updatedAt: null, verified: {} }
}

nodesElement.addEventListener("click", (event) => {
  const action = resolveNodeClick(event.target)
  if (action?.type === "toggle") toggleChildren(action.id)
  else if (action?.type === "open") openDialog(action.id)
})

document.querySelector("#close-dialog").addEventListener("click", () => nodeDialog.close())
nodeDialog.addEventListener("click", (event) => {
  if (event.target === nodeDialog) nodeDialog.close()
})
document.querySelector("#dialog-verify").addEventListener("click", (event) => toggleVerification(event.currentTarget.dataset.verifyNode))
document.querySelector("#dialog-toggle-children").addEventListener("click", (event) => toggleChildren(event.currentTarget.dataset.toggleNode))
document.querySelector("#dialog-focus").addEventListener("click", (event) => focusBranch(event.currentTarget.dataset.focusNode))
document.querySelector("#dialog-edit").addEventListener("click", (event) => openNodeEditor("edit", event.currentTarget.dataset.editNode))
document.querySelector("#dialog-add-child").addEventListener("click", (event) => openNodeEditor("add", event.currentTarget.dataset.addChild))
document.querySelector("#dialog-remove-node").addEventListener("click", (event) => openDeleteDialog(event.currentTarget.dataset.removeNode))
document.querySelector("#add-editor-section").addEventListener("click", () => {
  const sectionNumber = document.querySelectorAll(".editor-section").length + 1
  document.querySelector("#editor-sections").append(createEditorSection({
    key: `section-${sectionNumber}`,
    label: `Section ${sectionNumber}`,
    body: "",
  }))
  updateSectionControls()
})
document.querySelector("#editor-sections").addEventListener("click", (event) => {
  const section = event.target.closest(".editor-section")
  if (section === null) return
  if (event.target.closest("[data-remove-section]") !== null) section.remove()
  else if (event.target.closest('[data-move-section="up"]') !== null && section.previousElementSibling !== null) {
    section.parentElement.insertBefore(section, section.previousElementSibling)
  } else if (event.target.closest('[data-move-section="down"]') !== null && section.nextElementSibling !== null) {
    section.parentElement.insertBefore(section.nextElementSibling, section)
  }
  updateSectionControls()
})
editorForm.addEventListener("submit", (event) => {
  event.preventDefault()
  saveNodeEditor()
})
document.querySelector("#close-editor").addEventListener("click", () => editorDialog.close())
document.querySelector("#cancel-editor").addEventListener("click", () => editorDialog.close())
deleteDialog.addEventListener("close", () => {
  if (deleteDialog.returnValue === "confirm") deletePendingNode()
  else if (pendingDeleteId !== null && treeIndex.nodes.has(pendingDeleteId)) {
    const id = pendingDeleteId
    pendingDeleteId = null
    openDialog(id)
  }
})

document.querySelector("#zoom-out").addEventListener("click", () => zoomBy(0.82))
document.querySelector("#zoom-in").addEventListener("click", () => zoomBy(1.22))
document.querySelector("#fit-map").addEventListener("click", fitMap)
document.querySelector("#expand-all").addEventListener("click", expandAll)
document.querySelector("#collapse-map").addEventListener("click", collapseToFirstLevel)
document.querySelector("#show-full-tree").addEventListener("click", showFullTree)
resetButton.addEventListener("click", () => resetDialog.showModal())
resetDialog.addEventListener("close", () => {
  if (resetDialog.returnValue === "confirm") resetVerification()
})

viewportElement.addEventListener("wheel", (event) => {
  event.preventDefault()
  if (event.ctrlKey || event.metaKey) {
    zoomBy(Math.exp(-event.deltaY * 0.004), event.clientX, event.clientY)
    return
  }
  transform.x -= event.deltaX
  transform.y -= event.deltaY
  scheduleTransform()
}, { passive: false })

viewportElement.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".map-node") !== null) return
  dragState = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  viewportElement.setPointerCapture(event.pointerId)
  viewportElement.classList.add("is-panning")
  panLayerElement.classList.add("is-panning")
})

viewportElement.addEventListener("pointermove", (event) => {
  if (dragState === null || dragState.pointerId !== event.pointerId) return
  transform.x += event.clientX - dragState.x
  transform.y += event.clientY - dragState.y
  dragState.x = event.clientX
  dragState.y = event.clientY
  scheduleTransform()
})

const finishPan = (event) => {
  if (dragState === null || dragState.pointerId !== event.pointerId) return
  dragState = null
  viewportElement.classList.remove("is-panning")
  panLayerElement.classList.remove("is-panning")
}
viewportElement.addEventListener("pointerup", finishPan)
viewportElement.addEventListener("pointercancel", finishPan)

document.addEventListener("keydown", (event) => {
  if (nodeDialog.open || editorDialog.open || deleteDialog.open || resetDialog.open) return
  if (event.key === "+" || event.key === "=") {
    event.preventDefault()
    zoomBy(1.22)
  } else if (event.key === "-") {
    event.preventDefault()
    zoomBy(0.82)
  } else if (event.key === "0") {
    event.preventDefault()
    fitMap()
  } else if (event.key.toLowerCase() === "f" && selectedId !== null) {
    event.preventDefault()
    focusBranch(selectedId)
  } else if (event.key.toLowerCase() === "e" && selectedId !== null) {
    event.preventDefault()
    toggleChildren(selectedId)
  } else if (event.key === "ArrowLeft") {
    event.preventDefault()
    selectNearest("left")
  } else if (event.key === "ArrowRight") {
    event.preventDefault()
    selectNearest("right")
  } else if (event.key === "ArrowUp") {
    event.preventDefault()
    selectNearest("up")
  } else if (event.key === "ArrowDown") {
    event.preventDefault()
    selectNearest("down")
  }
})

new ResizeObserver(() => {
  if (currentLayout !== undefined) fitMap()
}).observe(viewportElement)

window.getGweMapDiagnostics = () => ({
  focusId,
  visibleNodes: currentLayout.nodes.map((node) => node.id),
  visibleEdges: currentLayout.edges.map((edge) => `${edge.parentId}->${edge.childId}`),
  rootChildren: currentLayout.edges.filter((edge) => edge.parentId === (focusId ?? proofTree.id)).map((edge) => edge.childId),
  scale: transform.scale,
  panTransform: panLayerElement.style.transform,
  sceneZoom: sceneElement.style.zoom,
})
