import type { GweNode } from "./model"

export type MapDifference =
  | { type: "add", nodeId: string, parentId: string | null, after: GweNode }
  | { type: "remove", nodeId: string, parentId: string | null, before: GweNode }
  | { type: "move", nodeId: string, beforeParentId: string | null, afterParentId: string | null }
  | { type: "update", nodeId: string, fields: string[], before: NodeContent, after: NodeContent }

export interface MapComparison {
  inSync: boolean
  differences: MapDifference[]
}

type NodeContent = Omit<GweNode, "id" | "children">

export function compareMaps(base: GweNode, current: GweNode): MapComparison {
  const baseIndex = indexMap(base)
  const currentIndex = indexMap(current)
  const nodeIds = new Set([...baseIndex.keys(), ...currentIndex.keys()])
  const differences: MapDifference[] = []

  for (const nodeId of [...nodeIds].sort(compareNodeIds)) {
    const before = baseIndex.get(nodeId)
    const after = currentIndex.get(nodeId)
    if (before === undefined && after !== undefined) {
      differences.push({ type: "add", nodeId, parentId: after.parentId, after: structuredClone(after.node) })
      continue
    }
    if (before !== undefined && after === undefined) {
      differences.push({ type: "remove", nodeId, parentId: before.parentId, before: structuredClone(before.node) })
      continue
    }
    if (before === undefined || after === undefined) continue
    if (before.parentId !== after.parentId) {
      differences.push({ type: "move", nodeId, beforeParentId: before.parentId, afterParentId: after.parentId })
    }
    const beforeContent = nodeContent(before.node)
    const afterContent = nodeContent(after.node)
    const fields = Object.keys(afterContent).filter((field) => JSON.stringify(beforeContent[field as keyof NodeContent]) !== JSON.stringify(afterContent[field as keyof NodeContent]))
    if (fields.length > 0) differences.push({ type: "update", nodeId, fields, before: beforeContent, after: afterContent })
  }

  return { inSync: differences.length === 0, differences }
}

function indexMap(root: GweNode): Map<string, { node: GweNode, parentId: string | null }> {
  const index = new Map<string, { node: GweNode, parentId: string | null }>()
  const visit = (node: GweNode, parentId: string | null) => {
    index.set(node.id, { node, parentId })
    for (const child of node.children ?? []) visit(child, node.id)
  }
  visit(root, null)
  return index
}

function nodeContent(node: GweNode): NodeContent {
  const { id: _id, children: _children, ...content } = node
  return structuredClone(content)
}

function compareNodeIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}
