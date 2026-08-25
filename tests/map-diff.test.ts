import { describe, expect, test } from "bun:test"

import { compareMaps } from "../src/map-diff"
import { parseTree } from "../src/model"

const node = (id: string, title: string, children?: unknown[]) => ({
  id,
  title,
  given: "A precondition holds.",
  when: "The map is compared.",
  expect: "The difference is explicit.",
  notes: "A semantic diff fixture.",
  evidence: "structural",
  source: "tests/map-diff.test.ts",
  ...(children === undefined ? {} : { children }),
})

describe("agent baseline comparison", () => {
  test("detects updates, additions, removals, and moves by stable node ID", () => {
    const base = parseTree(node("G0", "Root", [node("G1", "Old title"), node("G2", "Removed")]))
    const current = parseTree(node("G0", "Root", [node("G1", "New title", [node("G2", "Removed")]), node("G3", "Added")]))

    const result = compareMaps(base, current)

    expect(result.inSync).toBe(false)
    expect(result.differences.map(({ type, nodeId }) => `${type}:${nodeId}`)).toEqual([
      "update:G1",
      "move:G2",
      "add:G3",
    ])
  })
})
