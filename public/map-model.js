export const MAP_GEOMETRY = Object.freeze({
  rootWidth: 560,
  rootHeight: 216,
  nodeWidth: 270,
  nodeHeight: 304,
  siblingGap: 18,
  levelGap: 36,
  paddingX: 12,
  paddingY: 12,
})

export function createMapSurfacePresentation({ x, y, scale }) {
  return {
    panTransform: `translate(${x}px, ${y}px)`,
    sceneZoom: String(scale),
  }
}

export function createMapFitTransform({
  layoutWidth,
  layoutHeight,
  viewportWidth,
  viewportHeight,
  maxSiblingCount,
}) {
  const horizontalPadding = 12
  const topPadding = 8
  const bottomPadding = 12
  const minimumScale = maxSiblingCount > 5 ? 0.78 : 0.18
  const scale = clampValue(Math.min(
    (viewportWidth - horizontalPadding * 2) / layoutWidth,
    (viewportHeight - topPadding - bottomPadding) / layoutHeight,
  ), minimumScale, 1.1)

  return {
    scale,
    x: (viewportWidth - layoutWidth * scale) / 2,
    y: topPadding,
    isHorizontallyOverflowing: layoutWidth * scale > viewportWidth - horizontalPadding * 2,
  }
}

export function createNodeProofRows(node) {
  if (Array.isArray(node.sections)) {
    return node.sections.map((section) => ({
      key: section.key,
      label: section.label,
      html: section.body,
    }))
  }
  return [
    { key: "given", label: "Given", html: node.given },
    { key: "when", label: "When", html: node.when },
    { key: "expect", label: "Expect", html: node.expect },
    { key: "notes", label: "Notes", html: node.notes },
  ]
}

export function createMindmapBranchPath(edge) {
  const direction = edge.to.y >= edge.from.y ? 1 : -1
  const totalY = Math.abs(edge.to.y - edge.from.y)
  const stemLength = Math.min(24, Math.max(totalY * 0.3, 8))
  const stemEndY = edge.from.y + direction * stemLength
  const curveY = stemEndY + (edge.to.y - stemEndY) * 0.5

  return `M ${edge.from.x} ${edge.from.y} L ${edge.from.x} ${stemEndY} C ${edge.from.x} ${curveY} ${edge.to.x} ${curveY} ${edge.to.x} ${edge.to.y}`
}

export function resolveNodeClick(target) {
  const toggle = target?.closest?.("[data-toggle-node]")
  if (toggle !== null && toggle !== undefined) {
    return { type: "toggle", id: toggle.dataset.toggleNode }
  }

  const card = target?.closest?.("[data-node-id]")
  if (card !== null && card !== undefined) {
    return { type: "open", id: card.dataset.nodeId }
  }

  return null
}

export function visibleTree(root, expandedIds, focusId) {
  const focusRoot = focusId === null ? root : findNode(root, focusId)
  if (focusRoot === null) throw new Error(`Unknown focus node: ${focusId}`)

  const copyVisible = (node) => ({
    ...node,
    children: expandedIds.has(node.id)
      ? (node.children ?? []).map(copyVisible)
      : [],
  })

  return copyVisible(focusRoot)
}

export function createMapLayout(root) {
  const subtreeWidths = new Map()
  const nodes = []
  const edges = []
  let maxDepth = 0
  let maxSiblingCount = 0

  const measure = (node, depth) => {
    const nodeWidth = widthAtDepth(depth)
    const children = node.children ?? []
    maxSiblingCount = Math.max(maxSiblingCount, children.length)
    if (children.length === 0) {
      subtreeWidths.set(node.id, nodeWidth)
      return nodeWidth
    }
    const childrenWidth = children.reduce((sum, child) => sum + measure(child, depth + 1), 0)
      + MAP_GEOMETRY.siblingGap * (children.length - 1)
    const width = Math.max(nodeWidth, childrenWidth)
    subtreeWidths.set(node.id, width)
    return width
  }

  const rootWidth = measure(root, 0)

  const place = (node, left, depth, parentLayout = null) => {
    maxDepth = Math.max(maxDepth, depth)
    const subtreeWidth = subtreeWidths.get(node.id)
    const width = widthAtDepth(depth)
    const height = heightAtDepth(depth)
    const layoutNode = {
      ...node,
      x: MAP_GEOMETRY.paddingX + left + subtreeWidth / 2,
      y: yAtDepth(depth),
      width,
      height,
    }
    nodes.push(layoutNode)

    if (parentLayout !== null) {
      edges.push({
        parentId: parentLayout.id,
        childId: layoutNode.id,
        from: {
          x: parentLayout.x,
          y: parentLayout.y + parentLayout.height,
        },
        to: {
          x: layoutNode.x,
          y: layoutNode.y,
        },
      })
    }

    let childLeft = left
    for (const child of node.children ?? []) {
      place(child, childLeft, depth + 1, layoutNode)
      childLeft += subtreeWidths.get(child.id) + MAP_GEOMETRY.siblingGap
    }
  }

  place(root, 0, 0)

  return {
    nodes,
    edges,
    width: rootWidth + MAP_GEOMETRY.paddingX * 2,
    height: MAP_GEOMETRY.paddingY * 2
      + MAP_GEOMETRY.rootHeight
      + maxDepth * (MAP_GEOMETRY.nodeHeight + MAP_GEOMETRY.levelGap),
    maxSiblingCount,
  }
}

function widthAtDepth(depth) {
  return depth === 0 ? MAP_GEOMETRY.rootWidth : MAP_GEOMETRY.nodeWidth
}

function heightAtDepth(depth) {
  return depth === 0 ? MAP_GEOMETRY.rootHeight : MAP_GEOMETRY.nodeHeight
}

function yAtDepth(depth) {
  if (depth === 0) return MAP_GEOMETRY.paddingY
  return MAP_GEOMETRY.paddingY
    + MAP_GEOMETRY.rootHeight
    + MAP_GEOMETRY.levelGap
    + (depth - 1) * (MAP_GEOMETRY.nodeHeight + MAP_GEOMETRY.levelGap)
}

export function indexTree(root) {
  const nodes = new Map()
  const parents = new Map()

  const visit = (node, parentId = null) => {
    nodes.set(node.id, node)
    parents.set(node.id, parentId)
    for (const child of node.children ?? []) visit(child, node.id)
  }

  visit(root)
  return { nodes, parents }
}

export function createValidationPresentation(nodeId, verification, agentValidation, treeRevision) {
  const review = verification.reviews?.[nodeId]
  const human = review === undefined
    ? {
        status: "pending",
        label: "Human: pending",
        symbol: "○",
        description: "No human judgment has been recorded.",
      }
    : review.status === "validated"
      ? {
          status: "validated",
          label: "Human: validated",
          symbol: "✓",
          description: review.description || "A human confirmed that this Expect holds.",
        }
      : {
          status: "impossible",
          label: "Human: impossible",
          symbol: "×",
          description: review.description || "A human confirmed that this Expect cannot hold as written.",
        }

  const mark = agentValidation.validations?.[nodeId]
  const isStale = mark !== undefined && agentValidation.treeRevision !== treeRevision
  const agent = mark === undefined
    ? {
        status: "none",
        label: "Test: none",
        symbol: "−",
        description: "No reproducible automated test is linked to this node.",
        locations: [],
      }
    : isStale
      ? {
          status: "stale",
          label: "Test: stale",
          symbol: "!",
          description: `The linked test result targets tree revision ${agentValidation.treeRevision}, not current revision ${treeRevision}.`,
          locations: mark.locations,
        }
      : mark.status === "passed"
        ? {
            status: "passed",
            label: "Test: passed",
            symbol: "✓",
            description: mark.description,
            locations: mark.locations,
          }
        : {
            status: "failed",
            label: "Test: failed",
            symbol: "×",
            description: mark.description,
            locations: mark.locations,
          }

  return {
    human,
    agent,
    cardClasses: [`human-${human.status}`, `agent-${agent.status}`],
    command: agentValidation.command,
    agentUpdatedAt: agentValidation.updatedAt,
  }
}

function findNode(root, id) {
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const match = findNode(child, id)
    if (match !== null) return match
  }
  return null
}

function clampValue(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}
