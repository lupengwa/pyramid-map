import { describe, expect, test } from "bun:test"

import { createMapFitTransform, createMapSurfacePresentation, createValidationPresentation } from "../public/map-model.js"

describe("map surface presentation", () => {
  test("keeps magnification off the translated text surface", () => {
    const presentation = createMapSurfacePresentation({ x: 18.25, y: -7.5, scale: 1.67 })

    expect(presentation.panTransform).toBe("translate(18.25px, -7.5px)")
    expect(presentation.panTransform).not.toContain("scale")
    expect(presentation.sceneZoom).toBe("1.67")
  })

  test("keeps every intermediate zoom level on the layout surface", () => {
    for (const scale of [0.8, 0.98, 1.2, 1.46, 1.78]) {
      const presentation = createMapSurfacePresentation({ x: 0, y: 0, scale })

      expect(presentation.panTransform).toBe("translate(0px, 0px)")
      expect(presentation.sceneZoom).toBe(String(scale))
    }
  })

  test("keeps a readable five-card window when a node has more than five children", () => {
    const transform = createMapFitTransform({
      layoutWidth: 2028,
      layoutHeight: 540,
      viewportWidth: 1175,
      viewportHeight: 640,
      maxSiblingCount: 7,
    })

    expect(transform.scale).toBe(0.78)
    expect(transform.isHorizontallyOverflowing).toBe(true)
    expect(transform.x).toBeLessThan(0)
  })

  test("renders every human and agent validation combination as two independent statuses", () => {
    const humanCases = [
      ["pending", {}],
      ["validated", { G1: { status: "validated", description: "A human checked it.", reviewedAt: "2026-08-25T00:00:00.000Z" } }],
      ["impossible", { G1: { status: "impossible", description: "A human found a contradiction.", reviewedAt: "2026-08-25T00:00:00.000Z" } }],
    ] as const
    const agentCases = [
      ["none", 7, {}],
      ["passed", 7, { G1: { status: "passed", description: "The test passed.", locations: ["tests/example.test.ts:12"] } }],
      ["failed", 7, { G1: { status: "failed", description: "The test failed.", locations: ["tests/example.test.ts:12"] } }],
      ["stale", 6, { G1: { status: "passed", description: "An older test passed.", locations: ["tests/example.test.ts:12"] } }],
    ] as const

    for (const [humanStatus, reviews] of humanCases) {
      for (const [agentStatus, agentRevision, validations] of agentCases) {
        const presentation = createValidationPresentation(
          "G1",
          { version: 2, updatedAt: null, reviews },
          { version: 1, treeRevision: agentRevision, updatedAt: null, command: "bun run verify", validations },
          7,
        )

        expect(presentation.human.status).toBe(humanStatus)
        expect(presentation.agent.status).toBe(agentStatus)
        expect(presentation.cardClasses).toEqual([`human-${humanStatus}`, `agent-${agentStatus}`])
      }
    }
  })
})
