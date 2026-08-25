import { describe, expect, test } from "bun:test"

import tree from "../maps/native-dsh-web-path/tree.json"
import { createMapLayout, createMindmapBranchPath, createNodeProofRows, resolveNodeClick, visibleTree } from "../public/map-model.js"

describe("interactive proof map", () => {
  test("shows G0 connected to all four direct children at the default view", () => {
    const visible = visibleTree(tree, new Set(["G0"]), null)
    const layout = createMapLayout(visible)
    const rootEdges = layout.edges.filter((edge) => edge.parentId === "G0")

    expect(rootEdges.map((edge) => edge.childId)).toEqual(["G1", "G2", "G3", "G4"])
    expect(new Set(rootEdges.map((edge) => edge.to.y)).size).toBe(1)
  })

  test("draws each proof relationship as a smooth MindNode-style branch", () => {
    const visible = visibleTree(tree, new Set(["G0"]), null)
    const edge = createMapLayout(visible).edges[0]
    const path = createMindmapBranchPath(edge)

    expect(path.startsWith(`M ${edge.from.x} ${edge.from.y}`)).toBe(true)
    expect(path).toContain(" C ")
    expect(path.endsWith(`${edge.to.x} ${edge.to.y}`)).toBe(true)
    expect(path).not.toContain(" H ")
  })

  test("uses a compact two-level reading layout for the default proof", () => {
    const visible = visibleTree(tree, new Set(["G0"]), null)
    const layout = createMapLayout(visible)
    const root = layout.nodes.find((node) => node.id === "G0")
    const children = layout.nodes.filter((node) => node.id !== "G0")

    expect(root.width).toBeGreaterThan(children[0].width)
    expect(root.y).toBeLessThanOrEqual(18)
    expect(children[0].y - (root.y + root.height)).toBeLessThanOrEqual(54)
    expect(layout.width).toBeLessThanOrEqual(1200)
    expect(layout.height).toBeLessThanOrEqual(560)

    for (const node of layout.nodes) {
      const proofRows = createNodeProofRows(node)
      expect(proofRows.map((row) => row.key)).toEqual(["given", "when", "expect", "notes"])
      expect(proofRows.every((row) => row.html.trim() !== "")).toBe(true)
    }
  })

  test("focus rebuilds the visible map around one branch", () => {
    const visible = visibleTree(tree, new Set(["G0", "G3"]), "G3")
    const layout = createMapLayout(visible)

    expect(layout.nodes.map((node) => node.id)).toEqual(["G3", "G3.1", "G3.2", "G3.3", "G3.4", "G3.5"])
    expect(layout.edges).toHaveLength(5)
  })

  test("expanding every parent exposes every proof node", () => {
    const visible = visibleTree(tree, new Set(["G0", "G1", "G2", "G3", "G4"]), null)
    const layout = createMapLayout(visible)

    expect(layout.nodes).toHaveLength(22)
    expect(layout.edges).toHaveLength(21)
  })

  test("opens a node from any card surface while preserving the child toggle", () => {
    const cardTarget = closestTarget({ cardId: "G2" })
    const toggleTarget = closestTarget({ cardId: "G2", toggleId: "G2" })

    expect(resolveNodeClick(cardTarget)).toEqual({ type: "open", id: "G2" })
    expect(resolveNodeClick(toggleTarget)).toEqual({ type: "toggle", id: "G2" })
  })

  test("reports wide sibling fan-out without wrapping proof relationships", () => {
    const wideRoot = {
      ...tree,
      children: Array.from({ length: 7 }, (_, index) => ({
        ...tree.children[0],
        id: `W${index + 1}`,
        children: [],
      })),
    }
    const layout = createMapLayout(visibleTree(wideRoot, new Set(["G0"]), null))

    expect(layout.maxSiblingCount).toBe(7)
    expect(new Set(layout.nodes.slice(1).map((node) => node.y)).size).toBe(1)
  })
})

function closestTarget({ cardId, toggleId }) {
  return {
    closest(selector) {
      if (selector === "[data-toggle-node]" && toggleId !== undefined) {
        return { dataset: { toggleNode: toggleId } }
      }
      if (selector === "[data-node-id]") return { dataset: { nodeId: cardId } }
      return null
    },
  }
}
