import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readRuntimeIdentity } from "../src/runtime-identity"
import { stopSharedServer } from "../src/shared-server"

const appRoot = join(import.meta.dir, "..")
let temporaryRoot: string
let firstMap: string
let secondMap: string
let port: number
let serverPid: number | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "pyramid-map-launcher-"))
  firstMap = join(temporaryRoot, "first-map")
  secondMap = join(temporaryRoot, "second-map")
  await Promise.all([
    createMap(firstMap, "First launcher destination"),
    createMap(secondMap, "Second launcher destination"),
  ])
  port = reservePort()
})

afterEach(async () => {
  if (serverPid !== undefined) {
    try {
      process.kill(serverPid)
    } catch (error) {
      if (!isErrorCode(error, "ESRCH")) throw error
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("clickable map launcher runtime", () => {
  test("keeps the first server alive and reuses it for the second destination", async () => {
    const first = await runLauncher(firstMap)
    expect(first.status).toBe("started")

    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    const healthBody = await health.json() as { app: string, pid: number }
    expect(healthBody.app).toBe("pyramid-map")
    serverPid = healthBody.pid

    const second = await runLauncher(secondMap)
    expect(second.status).toBe("reused")
    expect(new URL(first.url).searchParams.get("map")).toBe(firstMap)
    expect(new URL(second.url).searchParams.get("map")).toBe(secondMap)

    expect(await stopSharedServer(port)).toEqual({ status: "stopped", port })
    serverPid = undefined
  })

  test("replaces a stale Pyramid Map runtime before opening the destination", async () => {
    const staleProcess = Bun.spawn([
      "bun",
      "run",
      "tests/fixtures/stale-pyramid-server.ts",
      String(port),
      appRoot,
    ], {
      cwd: appRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitForHealth(port, staleProcess)
    const stalePid = staleProcess.pid

    const opened = await runLauncher(firstMap)
    expect(opened.status).toBe("restarted")

    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    const healthBody = await health.json() as { pid: number, appRoot: string, runtimeFingerprint: string }
    const expectedIdentity = await readRuntimeIdentity(appRoot)
    expect(healthBody.pid).not.toBe(stalePid)
    expect(healthBody.appRoot).toBe(expectedIdentity.appRoot)
    expect(healthBody.runtimeFingerprint).toBe(expectedIdentity.fingerprint)
    serverPid = healthBody.pid
    expect(await staleProcess.exited).not.toBe(0)

    expect(await stopSharedServer(port)).toEqual({ status: "stopped", port })
    serverPid = undefined
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

async function runLauncher(mapDirectory: string) {
  const process_ = Bun.spawn(["bun", "run", "tests/fixtures/open-map.ts", mapDirectory, String(port)], {
    cwd: appRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process_.exited,
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Launcher fixture failed: ${stderr}`)
  return JSON.parse(stdout) as { status: "started" | "reused" | "restarted", map: string, url: string }
}

async function waitForHealth(selectedPort: number, process_: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process_.exitCode !== null) {
      const stderr = await new Response(process_.stderr).text()
      throw new Error(`Fixture server exited before becoming ready: ${stderr}`)
    }
    try {
      if ((await fetch(`http://127.0.0.1:${selectedPort}/healthz`)).ok) return
    } catch {
      await Bun.sleep(20)
    }
  }
  throw new Error(`Fixture server did not become ready on port ${selectedPort}`)
}

function reservePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
  const selectedPort = probe.port
  probe.stop(true)
  return selectedPort
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
