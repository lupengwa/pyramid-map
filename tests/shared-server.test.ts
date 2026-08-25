import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const appRoot = join(import.meta.dir, "..")
let temporaryRoot: string
let firstMap: string
let secondMap: string
let port: number
let serverProcess: ReturnType<typeof Bun.spawn> | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "pyramid-map-shared-server-"))
  firstMap = join(temporaryRoot, "first-map")
  secondMap = join(temporaryRoot, "second-map")
  await Promise.all([
    createMap(firstMap, "The first tab renders its own destination map."),
    createMap(secondMap, "The second tab renders its own destination map."),
  ])
  port = reservePort()
  serverProcess = Bun.spawn(["bun", "run", "server.ts", "--map", firstMap], {
    cwd: appRoot,
    env: { ...process.env, PYRAMID_MAP_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  })
  await waitForServer(port, serverProcess)
})

afterEach(async () => {
  serverProcess?.kill()
  if (serverProcess !== undefined) await serverProcess.exited
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("shared Pyramid Map server", () => {
  test("serves two destination maps on one port by tab URL", async () => {
    const firstTree = await fetchTree(firstMap)
    const secondTree = await fetchTree(secondMap)

    expect(firstTree.title).toBe("The first tab renders its own destination map.")
    expect(secondTree.title).toBe("The second tab renders its own destination map.")

    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(await health.json()).toMatchObject({ ok: true, app: "pyramid-map" })
  })
})

async function createMap(directory: string, title: string) {
  const source = JSON.parse(await readFile(join(appRoot, "maps/native-dsh-web-path/tree.json"), "utf8"))
  const root = source.root ?? source
  root.title = title
  await mkdir(join(directory, ".pyramid-map"), { recursive: true })
  await writeFile(join(directory, "tree.json"), `${JSON.stringify(source, null, 2)}\n`, "utf8")
  await writeFile(join(directory, ".pyramid-map", "agent-base.json"), `${JSON.stringify(source, null, 2)}\n`, "utf8")
  await writeFile(join(directory, "verification.json"), '{"version":1,"updatedAt":null,"verified":{}}\n', "utf8")
}

function reservePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
  const selectedPort = probe.port
  probe.stop(true)
  return selectedPort
}

async function waitForServer(selectedPort: number, process_: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process_.exitCode !== null) {
      const stderr = await new Response(process_.stderr).text()
      throw new Error(`Pyramid Map server exited before becoming ready: ${stderr}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${selectedPort}/healthz`)
      if (response.ok) return
    } catch {
      await Bun.sleep(20)
    }
  }
  throw new Error(`Pyramid Map server did not become ready on port ${selectedPort}`)
}

async function fetchTree(mapDirectory: string) {
  const url = new URL(`http://127.0.0.1:${port}/api/tree`)
  url.searchParams.set("map", mapDirectory)
  const response = await fetch(url)
  expect(response.status).toBe(200)
  return response.json() as Promise<{ title: string }>
}
