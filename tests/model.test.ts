import { describe, expect, test } from "bun:test"

import { collectNodeIds, parseTree, parseVerification } from "../src/model"

const leaf = {
  id: "G1",
  title: "A child result holds.",
  relationship: "This gives G0 the child result it needs.",
  given: "The child precondition holds.",
  when: "The child receives input.",
  expect: "The child produces a verifiable result.",
  notes: "A focused test node.",
  evidence: "source",
  source: "tests/model.test.ts:1",
}

const root = {
  id: "G0",
  title: "The root result holds.",
  given: "G1 holds.",
  when: "The root receives input.",
  expect: "The root produces a verifiable result.",
  notes: "A focused test root.",
  evidence: "e2e",
  source: "tests/model.test.ts:1",
  children: [leaf],
}

describe("proof data model", () => {
  test("accepts a complete GWE tree and collects stable IDs", () => {
    const parsed = parseTree(root)
    expect([...collectNodeIds(parsed)]).toEqual(["G0", "G1"])
    expect(parsed.children?.[0].relationship).toBe("This gives G0 the child result it needs.")
  })

  test("keeps legacy maps readable but rejects long or marked-up relationships", () => {
    expect(parseTree({ ...root, children: [{ ...leaf, relationship: undefined }] }).children?.[0].relationship).toBeUndefined()
    expect(() => parseTree({ ...root, children: [{ ...leaf, relationship: "x".repeat(181) }] })).toThrow("180 characters")
    expect(() => parseTree({ ...root, children: [{ ...leaf, relationship: "This <code>supports</code> G0." }] })).toThrow("plain text")
  })

  test("rejects duplicate node IDs", () => {
    expect(() => parseTree({ ...root, children: [leaf, { ...leaf }] })).toThrow("Duplicate GWE node id")
  })

  test("rejects an empty Expect", () => {
    expect(() => parseTree({ ...root, expect: "" })).toThrow("requires sections or a non-empty expect")
  })

  test("normalizes legacy GWE wording and accepts custom section patterns and styles", () => {
    const legacy = parseTree(root)
    const custom = parseTree({
      ...root,
      pattern: "claim-evidence",
      style: "mental-model",
      sections: [
        { key: "claim", label: "Claim", body: "The capability holds." },
        { key: "evidence", label: "Evidence", body: "The recorded path proves it." },
      ],
    })

    expect(legacy.sections.map((section) => section.label)).toEqual(["Given", "When", "Expect", "Notes"])
    expect(custom.pattern).toBe("claim-evidence")
    expect(custom.style).toBe("mental-model")
    expect(custom.sections.map((section) => section.key)).toEqual(["claim", "evidence"])
  })

  test("drops verification marks for nodes no longer in the tree", () => {
    const parsed = parseTree(root)
    const state = parseVerification({
      version: 1,
      updatedAt: null,
      verified: {
        G1: { verifiedAt: "2026-08-24T00:00:00.000Z" },
        G9: { verifiedAt: "2026-08-24T00:00:00.000Z" },
      },
    }, collectNodeIds(parsed))
    expect(Object.keys(state.verified)).toEqual(["G1"])
  })
})
