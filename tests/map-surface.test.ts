import { describe, expect, test } from "bun:test"

import { createMapFitTransform, createMapSurfacePresentation } from "../public/map-model.js"

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
})
