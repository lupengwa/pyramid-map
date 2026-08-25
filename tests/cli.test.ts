import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { decode } from "@toon-format/toon"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDataStore } from "../src/data-store"

const appRoot = join(import.meta.dir, "..")
let dataDir: string

const root = {
  id: "G0",
  title: "A shared map stays current.",
  given: "One map exists.",
  when: "Humans and agents edit it.",
  expect: "Both read the same current state.",
  notes: "A CLI fixture.",
  evidence: "e2e",
  source: "tests/cli.test.ts",
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pyramid-map-cli-test-"))
  await writeFile(join(dataDir, "tree.json"), `${JSON.stringify(root, null, 2)}\n`, "utf8")
  await writeFile(join(dataDir, "verification.json"), '{"version":1,"updatedAt":null,"verified":{}}\n', "utf8")
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe("pyramid-map agent CLI", () => {
  test("reads concise live content as TOON and exposes full flexible sections", async () => {
    const concise = await runCli(["read", "--data-dir", dataDir])
    expect(concise.exitCode).toBe(0)
    expect(decode(concise.stdout)).toMatchObject({ revision: 0, nodes: [{ id: "G0", pattern: "gwe-notes", style: "proof" }] })

    const full = await runCli(["view", "G0", "--full", "--data-dir", dataDir])
    const decodedFull = decode(full.stdout) as any
    expect(decodedFull.revision).toBe(0)
    expect(decodedFull.node.sections).toHaveLength(4)
    expect(decodedFull.node.sections[0]).toMatchObject({ key: "given", label: "Given" })
    expect(decodedFull.node.sections[1]).toMatchObject({ key: "when", label: "When" })
  })

  test("detects human edits and protects them from stale agent writes", async () => {
    const store = await createDataStore({
      treePath: join(dataDir, "tree.json"),
      verificationPath: join(dataDir, "verification.json"),
      activityPath: join(dataDir, "activity.jsonl"),
    })
    await store.updateNode("G0", { ...root, title: "The human clarified the intention." }, { actor: "human" })

    const changes = await runCli(["changes", "--since", "0", "--actor", "human", "--full", "--data-dir", dataDir])
    expect(decode(changes.stdout)).toMatchObject({
      revision: 1,
      changes: [{ revision: 1, actor: "human", nodeId: "G0", before: { title: "A shared map stays current." }, after: { title: "The human clarified the intention." } }],
    })

    const inputPath = join(dataDir, "edit.json")
    await writeFile(inputPath, JSON.stringify({
      title: "A custom review card.",
      pattern: "claim-reason-risk",
      style: "editorial",
      sections: [
        { key: "claim", label: "Claim", body: "The shared map is the source of truth." },
        { key: "risk", label: "Risk", body: "A stale agent can miss human intent." },
      ],
      evidence: "source",
      source: "tests/cli.test.ts",
    }), "utf8")

    const stale = await runCli(["update", "G0", "--input", inputPath, "--expected-revision", "0", "--data-dir", dataDir])
    expect(stale.exitCode).toBe(1)
    expect(decode(stale.stdout)).toMatchObject({ error: expect.stringContaining("Revision conflict") })

    const current = await runCli(["update", "G0", "--input", inputPath, "--expected-revision", "1", "--data-dir", dataDir])
    expect(current.exitCode).toBe(0)
    expect(decode(current.stdout)).toMatchObject({ ok: true, action: "update", nodeId: "G0", revision: 2 })
  })

  test("uses fast version output and structured usage errors", async () => {
    const version = await runCli(["--version"])
    expect(version).toMatchObject({ exitCode: 0, stdout: "1.0.0\n" })

    const invalid = await runCli(["unknown", "--data-dir", dataDir])
    expect(invalid.exitCode).toBe(2)
    expect(decode(invalid.stdout)).toMatchObject({ error: "Unknown command: unknown" })
  })
})

async function runCli(args: string[]): Promise<{ exitCode: number, stdout: string, stderr: string }> {
  const process = Bun.spawn(["bun", "run", "bin/pyramid-map", ...args], {
    cwd: appRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}
