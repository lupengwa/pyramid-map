import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import {
  collectNodeIds,
  emptyAgentValidation,
  parseAgentValidation,
  parseEditableNode,
  parseMapDocument,
  parseTree,
  parseVerification,
  type AgentValidationState,
  type EditableGweNode,
  type GweNode,
  type HumanReviewStatus,
  type ProofMapDocument,
  type VerificationState,
} from "./model"

export interface MapSnapshot {
  revision: number
  tree: GweNode
  verification: VerificationState
  agentValidation: AgentValidationState
}

export interface DataStore {
  refresh(): Promise<void>
  getSnapshot(): MapSnapshot
  getTree(): GweNode
  getVerification(): VerificationState
  getAgentValidation(): AgentValidationState
  hasNode(id: string): boolean
  setHumanReview(id: string, review: { status: HumanReviewStatus | null, description: string }): Promise<VerificationState>
  resetVerification(): Promise<VerificationState>
  updateNode(id: string, input: unknown): Promise<TreeMutationResult>
  addChild(parentId: string, input: unknown): Promise<TreeMutationResult & { nodeId: string }>
  removeNode(id: string): Promise<TreeMutationResult & { parentId: string, removedIds: string[] }>
}

export interface TreeMutationResult extends MapSnapshot {}

export interface DataStorePaths {
  treePath: string
  verificationPath: string
  agentValidationPath?: string
}

export async function createDataStore(paths: DataStorePaths): Promise<DataStore> {
  let document = parseMapDocument(JSON.parse(await readFile(paths.treePath, "utf8")))
  let tree = document.root
  let validIds = collectNodeIds(tree)
  let state = parseVerification(JSON.parse(await readFile(paths.verificationPath, "utf8")), validIds)
  let agentValidation = await readAgentValidation(paths.agentValidationPath, validIds, document.revision)
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
    agentValidation = await readAgentValidation(paths.agentValidationPath, validIds, document.revision)
  }

  const mutate = <Result>(work: () => Promise<Result>) => enqueue(
    () => withFileLock(paths.treePath, async () => {
      await refreshUnlocked()
      return work()
    }),
  )

  const commit = async (nextTree: GweNode, nextState: VerificationState) => {
    const treeChanged = nextTree !== tree
    const nextDocument: ProofMapDocument = treeChanged
      ? { version: 2, revision: document.revision + 1, root: nextTree }
      : document
    if (treeChanged) await writeJsonAtomically(paths.treePath, nextDocument)
    if (nextState !== state) await writeJsonAtomically(paths.verificationPath, nextState)
    document = nextDocument
    tree = nextTree
    validIds = collectNodeIds(tree)
    state = nextState
  }

  return {
    refresh: () => enqueue(refreshUnlocked),
    getSnapshot: () => snapshot(document.revision, tree, state, agentValidation),
    getTree: () => structuredClone(tree),
    getVerification: () => cloneState(state),
    getAgentValidation: () => structuredClone(agentValidation),
    hasNode: (id) => validIds.has(id),
    setHumanReview: (id, review) => mutate(async () => {
      if (!validIds.has(id)) throw new Error(`Unknown GWE node: ${id}`)
      if (review.status !== null && review.status !== "validated" && review.status !== "impossible") {
        throw new Error(`Unknown human review status: ${String(review.status)}`)
      }
      const description = review.description.trim()
      if (description.length > 1_000) throw new Error("Human review description must be 1000 characters or fewer")
      const previous = state.reviews[id]
      if ((review.status === null && previous === undefined)
        || (review.status !== null && previous?.status === review.status && previous.description === description)) {
        return cloneState(state)
      }
      const now = new Date().toISOString()
      const reviews = { ...state.reviews }
      if (review.status === null) delete reviews[id]
      else reviews[id] = { status: review.status, description, reviewedAt: now }
      const nextState: VerificationState = { version: 2, updatedAt: now, reviews }
      await commit(tree, nextState)
      return cloneState(state)
    }),
    resetVerification: () => mutate(async () => {
      if (Object.keys(state.reviews).length === 0) return cloneState(state)
      const nextState: VerificationState = { version: 2, updatedAt: new Date().toISOString(), reviews: {} }
      await commit(tree, nextState)
      return cloneState(state)
    }),
    updateNode: (id, input) => mutate(async () => {
      if (!validIds.has(id)) throw new Error(`Unknown GWE node: ${id}`)
      const before = findNode(tree, id)
      if (before === null) throw new Error(`Unknown GWE node: ${id}`)
      const content = parseEditableNode(input, id !== tree.id)
      const changedFields = changedContentFields(before, content)
      if (changedFields.length === 0) return mutationResult(document.revision, tree, state, agentValidation)
      const nextTree = parseTree(updateNodeContent(tree, id, content))
      await commit(nextTree, state)
      return mutationResult(document.revision, tree, state, agentValidation)
    }),
    addChild: (parentId, input) => mutate(async () => {
      if (!validIds.has(parentId)) throw new Error(`Unknown GWE node: ${parentId}`)
      const content = parseEditableNode(input, true)
      const nodeId = nextChildId(tree, parentId)
      const child: GweNode = { id: nodeId, ...content }
      const nextTree = parseTree(appendChild(tree, parentId, child))
      await commit(nextTree, state)
      return { ...mutationResult(document.revision, tree, state, agentValidation), nodeId }
    }),
    removeNode: (id) => mutate(async () => {
      if (id === tree.id) throw new Error("The proof tree root cannot be removed")
      if (!validIds.has(id)) throw new Error(`Unknown GWE node: ${id}`)
      const parentId = findParentId(tree, id)
      const removedNode = findNode(tree, id)
      if (parentId === null || removedNode === null) throw new Error(`Cannot resolve the subtree rooted at ${id}`)
      const removedIds = [...collectNodeIds(removedNode)]
      const nextTree = parseTree(removeSubtree(tree, id))
      const nextReviews = { ...state.reviews }
      for (const removedId of removedIds) delete nextReviews[removedId]
      const verificationChanged = Object.keys(nextReviews).length !== Object.keys(state.reviews).length
      const nextState: VerificationState = verificationChanged
        ? { version: 2, updatedAt: new Date().toISOString(), reviews: nextReviews }
        : state
      await commit(nextTree, nextState)
      return { ...mutationResult(document.revision, tree, state, agentValidation), parentId, removedIds }
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

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporaryPath, path)
}

function snapshot(revision: number, tree: GweNode, verification: VerificationState, agentValidation: AgentValidationState): MapSnapshot {
  return {
    revision,
    tree: structuredClone(tree),
    verification: cloneState(verification),
    agentValidation: structuredClone(agentValidation),
  }
}

function cloneState(state: VerificationState): VerificationState {
  return structuredClone(state)
}

function mutationResult(revision: number, tree: GweNode, verification: VerificationState, agentValidation: AgentValidationState): TreeMutationResult {
  return snapshot(revision, tree, verification, agentValidation)
}

async function readAgentValidation(path: string | undefined, validIds: Set<string>, treeRevision: number): Promise<AgentValidationState> {
  if (path === undefined) return emptyAgentValidation(treeRevision)
  try {
    return parseAgentValidation(JSON.parse(await readFile(path, "utf8")), validIds)
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return emptyAgentValidation(treeRevision)
    throw error
  }
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
