import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  collectNodeIds,
  parseEditableNode,
  parseMapDocument,
  parseTree,
  parseVerification,
  type EditableGweNode,
  type GweNode,
  type ProofMapDocument,
  type VerificationState,
} from "./model"

export type MutationActor = "human" | "agent"
export type MapAction = "import" | "update" | "add" | "remove" | "verify" | "unverify" | "reset-verification"

export interface MutationOptions {
  actor?: MutationActor
  expectedRevision?: number
}

export interface MapActivity {
  revision: number
  timestamp: string
  actor: MutationActor | "system"
  action: MapAction
  nodeId: string
  parentId?: string
  summary: string
  before?: unknown
  after?: unknown
}

export interface MapSnapshot {
  revision: number
  tree: GweNode
  verification: VerificationState
}

export interface DataStore {
  refresh(): Promise<void>
  getSnapshot(): MapSnapshot
  getTree(): GweNode
  getVerification(): VerificationState
  getActivities(sinceRevision?: number, actor?: MutationActor): MapActivity[]
  hasNode(id: string): boolean
  setVerified(id: string, isVerified: boolean, options?: MutationOptions): Promise<VerificationState>
  resetVerification(options?: MutationOptions): Promise<VerificationState>
  updateNode(id: string, input: unknown, options?: MutationOptions): Promise<TreeMutationResult>
  addChild(parentId: string, input: unknown, options?: MutationOptions): Promise<TreeMutationResult & { nodeId: string }>
  removeNode(id: string, options?: MutationOptions): Promise<TreeMutationResult & { parentId: string, removedIds: string[] }>
}

export interface TreeMutationResult extends MapSnapshot {}

export interface DataStorePaths {
  treePath: string
  verificationPath: string
  activityPath?: string
}

export async function createDataStore(paths: DataStorePaths): Promise<DataStore> {
  const activityPath = paths.activityPath ?? join(dirname(paths.treePath), "activity.jsonl")
  let document = parseMapDocument(JSON.parse(await readFile(paths.treePath, "utf8")))
  let tree = document.root
  let validIds = collectNodeIds(tree)
  let state = parseVerification(JSON.parse(await readFile(paths.verificationPath, "utf8")), validIds)
  let activities = await readActivities(activityPath)
  let writeQueue = Promise.resolve()

  const enqueue = <Result>(work: () => Promise<Result>): Promise<Result> => {
    const operation = writeQueue.then(work)
    writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  const refreshUnlocked = async () => {
    document = parseMapDocument(JSON.parse(await readFile(paths.treePath, "utf8")))
    tree = document.root
    validIds = collectNodeIds(tree)
    state = parseVerification(JSON.parse(await readFile(paths.verificationPath, "utf8")), validIds)
    activities = await readActivities(activityPath)
  }

  const mutate = <Result>(options: MutationOptions | undefined, work: (actor: MutationActor) => Promise<Result>) => enqueue(
    () => withFileLock(paths.treePath, async () => {
      await refreshUnlocked()
      assertExpectedRevision(options?.expectedRevision, document.revision)
      return work(options?.actor ?? "human")
    }),
  )

  const commit = async (nextTree: GweNode, nextState: VerificationState, activity: Omit<MapActivity, "revision" | "timestamp">) => {
    const nextRevision = document.revision + 1
    const nextDocument: ProofMapDocument = { version: 2, revision: nextRevision, root: nextTree }
    const nextActivity: MapActivity = { revision: nextRevision, timestamp: new Date().toISOString(), ...activity }
    await writeJsonAtomically(paths.treePath, nextDocument)
    if (nextState !== state) await writeJsonAtomically(paths.verificationPath, nextState)
    await appendActivity(activityPath, nextActivity)
    document = nextDocument
    tree = nextTree
    validIds = collectNodeIds(tree)
    state = nextState
    activities.push(nextActivity)
  }

  return {
    refresh: () => enqueue(refreshUnlocked),
    getSnapshot: () => snapshot(document.revision, tree, state),
    getTree: () => structuredClone(tree),
    getVerification: () => cloneState(state),
    getActivities: (sinceRevision = -1, actor) => activities
      .filter((activity) => activity.revision > sinceRevision && (actor === undefined || activity.actor === actor))
      .map((activity) => structuredClone(activity)),
    hasNode: (id) => validIds.has(id),
    setVerified: (id, isVerified, options) => mutate(options, async (actor) => {
      if (!validIds.has(id)) throw new Error(`Unknown GWE node: ${id}`)
      const alreadyVerified = id in state.verified
      if (alreadyVerified === isVerified) return cloneState(state)
      const now = new Date().toISOString()
      const verified = { ...state.verified }
      if (isVerified) verified[id] = { verifiedAt: now }
      else delete verified[id]
      const nextState: VerificationState = { version: 1, updatedAt: now, verified }
      await commit(tree, nextState, {
        actor,
        action: isVerified ? "verify" : "unverify",
        nodeId: id,
        summary: `${id} ${isVerified ? "marked verified" : "unmarked"}`,
        before: { verified: alreadyVerified },
        after: { verified: isVerified },
      })
      return cloneState(state)
    }),
    resetVerification: (options) => mutate(options, async (actor) => {
      if (Object.keys(state.verified).length === 0) return cloneState(state)
      const nextState: VerificationState = { version: 1, updatedAt: new Date().toISOString(), verified: {} }
      await commit(tree, nextState, {
        actor,
        action: "reset-verification",
        nodeId: tree.id,
        summary: `Cleared ${Object.keys(state.verified).length} verification marks`,
        before: { verifiedIds: Object.keys(state.verified) },
        after: { verifiedIds: [] },
      })
      return cloneState(state)
    }),
    updateNode: (id, input, options) => mutate(options, async (actor) => {
      if (!validIds.has(id)) throw new Error(`Unknown GWE node: ${id}`)
      const before = findNode(tree, id)
      if (before === null) throw new Error(`Unknown GWE node: ${id}`)
      const content = parseEditableNode(input)
      const changedFields = changedContentFields(before, content)
      if (changedFields.length === 0) return mutationResult(document.revision, tree, state)
      const nextTree = parseTree(updateNodeContent(tree, id, content))
      await commit(nextTree, state, {
        actor,
        action: "update",
        nodeId: id,
        summary: `Updated ${id}: ${changedFields.join(", ")}`,
        before: nodeContent(before),
        after: content,
      })
      return mutationResult(document.revision, tree, state)
    }),
    addChild: (parentId, input, options) => mutate(options, async (actor) => {
      if (!validIds.has(parentId)) throw new Error(`Unknown GWE node: ${parentId}`)
      const content = parseEditableNode(input)
      const nodeId = nextChildId(tree, parentId)
      const child: GweNode = { id: nodeId, ...content }
      const nextTree = parseTree(appendChild(tree, parentId, child))
      await commit(nextTree, state, {
        actor,
        action: "add",
        nodeId,
        parentId,
        summary: `Added ${nodeId} under ${parentId}`,
        after: child,
      })
      return { ...mutationResult(document.revision, tree, state), nodeId }
    }),
    removeNode: (id, options) => mutate(options, async (actor) => {
      if (id === tree.id) throw new Error("The proof tree root cannot be removed")
      if (!validIds.has(id)) throw new Error(`Unknown GWE node: ${id}`)
      const parentId = findParentId(tree, id)
      const removedNode = findNode(tree, id)
      if (parentId === null || removedNode === null) throw new Error(`Cannot resolve the subtree rooted at ${id}`)
      const removedIds = [...collectNodeIds(removedNode)]
      const nextTree = parseTree(removeSubtree(tree, id))
      const nextVerified = { ...state.verified }
      for (const removedId of removedIds) delete nextVerified[removedId]
      const verificationChanged = Object.keys(nextVerified).length !== Object.keys(state.verified).length
      const nextState: VerificationState = verificationChanged
        ? { version: 1, updatedAt: new Date().toISOString(), verified: nextVerified }
        : state
      await commit(nextTree, nextState, {
        actor,
        action: "remove",
        nodeId: id,
        parentId,
        summary: `Removed ${id} and ${removedIds.length - 1} descendants`,
        before: removedNode,
      })
      return { ...mutationResult(document.revision, tree, state), parentId, removedIds }
    }),
  }
}

async function withFileLock<Result>(treePath: string, work: () => Promise<Result>): Promise<Result> {
  const lockPath = `${treePath}.lock`
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error
      const lockAge = Date.now() - (await stat(lockPath)).mtimeMs
      if (lockAge > 30_000) {
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error("The map is busy with another writer; retry the command")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    return await work()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

async function readActivities(path: string): Promise<MapActivity[]> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return []
    throw error
  }
  return content.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as MapActivity
    } catch {
      throw new Error(`Invalid activity entry at ${path}:${index + 1}`)
    }
  })
}

async function appendActivity(path: string, activity: MapActivity): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(activity)}\n`, "utf8")
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporaryPath, path)
}

function assertExpectedRevision(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error(`Revision conflict: expected ${expected}, latest is ${actual}. Read the map and human changes again before updating.`)
  }
}

function snapshot(revision: number, tree: GweNode, verification: VerificationState): MapSnapshot {
  return { revision, tree: structuredClone(tree), verification: cloneState(verification) }
}

function cloneState(state: VerificationState): VerificationState {
  return structuredClone(state)
}

function mutationResult(revision: number, tree: GweNode, verification: VerificationState): TreeMutationResult {
  return snapshot(revision, tree, verification)
}

function nodeContent(node: GweNode): EditableGweNode {
  const { id: _id, children: _children, ...content } = node
  return structuredClone(content)
}

function changedContentFields(before: GweNode, after: EditableGweNode): string[] {
  return Object.keys(after).filter((key) => JSON.stringify(before[key as keyof GweNode]) !== JSON.stringify(after[key as keyof EditableGweNode]))
}

function updateNodeContent(node: GweNode, id: string, content: EditableGweNode): GweNode {
  if (node.id === id) return { id: node.id, ...content, ...(node.children === undefined ? {} : { children: node.children }) }
  return { ...node, ...(node.children === undefined ? {} : { children: node.children.map((child) => updateNodeContent(child, id, content)) }) }
}

function appendChild(node: GweNode, parentId: string, child: GweNode): GweNode {
  if (node.id === parentId) return { ...node, children: [...(node.children ?? []), child] }
  return { ...node, ...(node.children === undefined ? {} : { children: node.children.map((current) => appendChild(current, parentId, child)) }) }
}

function removeSubtree(node: GweNode, id: string): GweNode {
  if (node.children === undefined) return node
  const children = node.children.filter((child) => child.id !== id).map((child) => removeSubtree(child, id))
  const { children: _children, ...withoutChildren } = node
  return children.length === 0 ? withoutChildren : { ...withoutChildren, children }
}

function nextChildId(root: GweNode, parentId: string): string {
  const parent = findNode(root, parentId)
  if (parent === null) throw new Error(`Unknown GWE node: ${parentId}`)
  const prefix = parentId === root.id ? "G" : `${parentId}.`
  const siblingNumbers = (parent.children ?? [])
    .map((child) => child.id.startsWith(prefix) ? Number(child.id.slice(prefix.length)) : Number.NaN)
    .filter((value) => Number.isInteger(value) && value > 0)
  return `${prefix}${Math.max(0, ...siblingNumbers) + 1}`
}

function findNode(node: GweNode, id: string): GweNode | null {
  if (node.id === id) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, id)
    if (found !== null) return found
  }
  return null
}

function findParentId(node: GweNode, id: string): string | null {
  for (const child of node.children ?? []) {
    if (child.id === id) return node.id
    const parentId = findParentId(child, id)
    if (parentId !== null) return parentId
  }
  return null
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
