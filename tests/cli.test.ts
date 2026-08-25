import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { decode } from "@toon-format/toon"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const appRoot = join(import.meta.dir, "..")
let mapDir: string

const root = {
  id: "G0",
  title: "A shared map stays current.",
  given: "One map exists.",
  when: "A human edits it.",
  expect: "The agent detects the semantic difference.",
  notes: "A CLI fixture.",
  evidence: "e2e",
  source: "tests/cli.test.ts",
}

beforeEach(async () => {
  mapDir = await mkdtemp(join(tmpdir(), "pyramid-map-cli-test-"))
  await mkdir(join(mapDir, ".pyramid-map"))
  const tree = `${JSON.stringify(root, null, 2)}\n`
  await writeFile(join(mapDir, "tree.json"), tree, "utf8")
  await writeFile(join(mapDir, ".pyramid-map", "agent-base.json"), tree, "utf8")
  await writeFile(join(mapDir, "verification.json"), '{"version":1,"updatedAt":null,"verified":{}}\n', "utf8")
})

afterEach(async () => {
  await rm(mapDir, { recursive: true, force: true })
})

describe("pyramid-map inspection CLI", () => {
  test("reports an identical agent baseline as synchronized", async () => {
    const result = await runCli(["read", "--map", mapDir])
    expect(result.exitCode).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ revision: 0, agentBaseInSync: true, differenceCount: 0 })
  })

  test("reports the semantic diff after a human changes tree.json only", async () => {
    await writeFile(join(mapDir, "tree.json"), `${JSON.stringify({ ...root, title: "The human clarified the intention." }, null, 2)}\n`, "utf8")

    const result = await runCli(["diff", "--full", "--map", mapDir])
    const output = decode(result.stdout) as any
    expect(output.inSync).toBe(false)
    expect(output.differenceCount).toBe(1)
    expect(output.differences[0]).toMatchObject({ type: "update", nodeId: "G0", fields: ["title"] })
  })

  test("returns to synchronized after the agent writes identical JSON to both files", async () => {
    const accepted = `${JSON.stringify({ ...root, title: "The agent accepted and refined the map." }, null, 2)}\n`
    await writeFile(join(mapDir, "tree.json"), accepted, "utf8")
    await writeFile(join(mapDir, ".pyramid-map", "agent-base.json"), accepted, "utf8")

    const result = await runCli(["diff", "--map", mapDir])
    expect(decode(result.stdout)).toMatchObject({ inSync: true, differenceCount: 0, differences: [] })
  })

  test("uses fast version output and structured usage errors", async () => {
    const version = await runCli(["--version"])
    expect(version).toMatchObject({ exitCode: 0, stdout: "1.0.0\n" })

    const invalid = await runCli(["unknown", "--map", mapDir])
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
