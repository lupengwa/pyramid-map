import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDataStore } from "../src/data-store"

let temporaryRoot: string
let treePath: string
let verificationPath: string
let activityPath: string

const root = {
  id: "G0",
  title: "The root result holds.",
  given: "G1 holds.",
  when: "The root receives input.",
  expect: "The root produces a result.",
  notes: "A focused test root.",
  evidence: "e2e",
  source: "tests/data-store.test.ts:1",
  children: [{
    id: "G1",
    title: "A child result holds.",
    given: "The child precondition holds.",
    when: "The child receives input.",
    expect: "The child produces a result.",
    notes: "A focused test child.",
    evidence: "source",
    source: "tests/data-store.test.ts:1",
  }],
}

const childInput = {
  title: "A manually added capability holds.",
  given: "The manual precondition holds.",
  when: "The human adds a child.",
  expect: "The child persists in <code>tree.json</code>.",
  notes: "Created through the authoring path.",
  evidence: "structural",
  source: "manual",
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-gwe-store-test-"))
  treePath = join(temporaryRoot, "tree.json")
  verificationPath = join(temporaryRoot, "verification.json")
  activityPath = join(temporaryRoot, "activity.jsonl")
  await writeFile(treePath, `${JSON.stringify(root, null, 2)}\n`, "utf8")
  await writeFile(verificationPath, '{"version":1,"updatedAt":null,"verified":{}}\n', "utf8")
})

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("editable proof store", () => {
  test("updates node content and persists it to the tree file", async () => {
    const store = await createDataStore({ treePath, verificationPath, activityPath })
    const result = await store.updateNode("G1", { ...childInput, title: "Edited capability." })

    expect(result.tree.children?.[0].title).toBe("Edited capability.")
    expect(JSON.parse(await readFile(treePath, "utf8")).root.children[0].title).toBe("Edited capability.")
    expect(result.revision).toBe(1)
  })

  test("adds a child with a generated hierarchical ID", async () => {
    const store = await createDataStore({ treePath, verificationPath, activityPath })
    const result = await store.addChild("G1", childInput)

    expect(result.nodeId).toBe("G1.1")
    expect(result.tree.children?.[0].children?.[0].id).toBe("G1.1")
    expect(JSON.parse(await readFile(treePath, "utf8")).root.children[0].children[0].id).toBe("G1.1")
  })

  test("removes a subtree and its verification marks but protects G0", async () => {
    const store = await createDataStore({ treePath, verificationPath, activityPath })
    const added = await store.addChild("G1", childInput)
    await store.setVerified("G1", true)
    await store.setVerified(added.nodeId, true)

    const result = await store.removeNode("G1")

    expect(result.removedIds).toEqual(["G1", "G1.1"])
    expect(result.parentId).toBe("G0")
    expect(result.tree.children).toBeUndefined()
    expect(result.verification.verified).toEqual({})
    expect(JSON.parse(await readFile(verificationPath, "utf8")).verified).toEqual({})
    await expect(store.removeNode("G0")).rejects.toThrow("root")
  })

  test("rejects executable HTML in manually authored proof text", async () => {
    const store = await createDataStore({ treePath, verificationPath, activityPath })

    await expect(store.updateNode("G1", {
      ...childInput,
      notes: "<script>alert('no')</script>",
    })).rejects.toThrow("only supports plain text and <code>")
  })

  test("records human and agent changes and rejects stale agent revisions", async () => {
    const store = await createDataStore({ treePath, verificationPath, activityPath })
    await store.updateNode("G1", { ...childInput, title: "Human clarified capability." }, { actor: "human" })

    const humanChanges = store.getActivities(0, "human")
    expect(humanChanges).toHaveLength(1)
    expect(humanChanges[0]).toMatchObject({ revision: 1, actor: "human", action: "update", nodeId: "G1" })
    expect(humanChanges[0].before).toBeDefined()
    expect(humanChanges[0].after).toBeDefined()

    await store.addChild("G1", childInput, { actor: "agent", expectedRevision: 1 })
    expect(store.getSnapshot().revision).toBe(2)
    await expect(store.setVerified("G1", true, { actor: "agent", expectedRevision: 1 })).rejects.toThrow("Revision conflict")

    const persistedActivities = (await readFile(activityPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(persistedActivities.map(({ actor, revision }) => ({ actor, revision }))).toEqual([
      { actor: "human", revision: 1 },
      { actor: "agent", revision: 2 },
    ])
  })
})
