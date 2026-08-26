import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readRuntimeIdentity } from "../src/runtime-identity"

const sourceRoot = join(import.meta.dir, "..")
let temporaryRoot: string | undefined
let livePid: number | undefined

afterEach(async () => {
  if (livePid !== undefined) {
    try {
      process.kill(livePid, "SIGTERM")
    } catch (error) {
      if (!isErrorCode(error, "ESRCH")) throw error
    }
    livePid = undefined
  }
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe("browser runtime refresh", () => {
  test("verifies changed code and hands the port to a fresh process", async () => {
    const { appRoot, mapRoot } = await createRuntimeFixture("console.log('fixture verified')\n")

    const port = reservePort()
    const firstProcess = Bun.spawn(["bun", "run", "server.ts", "--map", mapRoot], {
      cwd: appRoot,
      env: { ...process.env, PYRAMID_MAP_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitForIdentity(port, firstProcess)
    livePid = firstProcess.pid
    const firstIdentity = await readRuntimeIdentity(appRoot)

    const stylesPath = join(appRoot, "public", "styles.css")
    await writeFile(stylesPath, `${await readFile(stylesPath, "utf8")}\n/* changed runtime */\n`)
    const changedIdentity = await readRuntimeIdentity(appRoot)
    expect(changedIdentity.fingerprint).not.toBe(firstIdentity.fingerprint)

    const refreshResponse = await fetch(`http://127.0.0.1:${port}/`)
    expect(refreshResponse.status).toBe(200)
    expect(await refreshResponse.text()).toContain("Updating Pyramid Map")

    const replacementHealth = await waitForFingerprint(port, changedIdentity.fingerprint)
    expect(replacementHealth.pid).not.toBe(firstProcess.pid)
    livePid = replacementHealth.pid
    expect(await firstProcess.exited).toBe(0)

    const mapUrl = new URL(`http://127.0.0.1:${port}/api/tree`)
    mapUrl.searchParams.set("map", mapRoot)
    expect((await fetch(mapUrl)).status).toBe(200)
  })

  test("keeps the previous process alive when verification fails and retries on refresh", async () => {
    const { appRoot, mapRoot, verificationPath } = await createRuntimeFixture("process.exit(1)\n")
    const port = reservePort()
    const firstProcess = Bun.spawn(["bun", "run", "server.ts", "--map", mapRoot], {
      cwd: appRoot,
      env: { ...process.env, PYRAMID_MAP_PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitForIdentity(port, firstProcess)
    livePid = firstProcess.pid
    const startupIdentity = await readRuntimeIdentity(appRoot)

    const stylesPath = join(appRoot, "public", "styles.css")
    await writeFile(stylesPath, `${await readFile(stylesPath, "utf8")}\n/* initially rejected runtime */\n`)
    const changedIdentity = await readRuntimeIdentity(appRoot)

    const rejected = await fetch(`http://127.0.0.1:${port}/`)
    expect(rejected.status).toBe(503)
    expect(await rejected.text()).toContain("previous runtime is still active")
    const survivingHealth = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json())
    expect(survivingHealth).toMatchObject({
      pid: firstProcess.pid,
      runtimeFingerprint: startupIdentity.fingerprint,
    })
    expect(firstProcess.exitCode).toBeNull()

    await writeFile(verificationPath, "console.log('fixture recovered')\n")
    const retried = await fetch(`http://127.0.0.1:${port}/`)
    expect(retried.status).toBe(200)
    expect(await retried.text()).toContain("Updating Pyramid Map")
    const replacementHealth = await waitForFingerprint(port, changedIdentity.fingerprint)
    expect(replacementHealth.pid).not.toBe(firstProcess.pid)
    livePid = replacementHealth.pid
    expect(await firstProcess.exited).toBe(0)
  })
})

async function createRuntimeFixture(verificationSource: string) {
  temporaryRoot = await mkdtemp(join(tmpdir(), "pyramid-map-refresh-"))
  const appRoot = join(temporaryRoot, "app")
  const mapRoot = join(temporaryRoot, "map")
  const verificationPath = join(appRoot, "verify-fixture.ts")
  await Promise.all([
    mkdir(appRoot, { recursive: true }),
    mkdir(join(mapRoot, ".pyramid-map"), { recursive: true }),
  ])
  await Promise.all([
    cp(join(sourceRoot, "server.ts"), join(appRoot, "server.ts")),
    cp(join(sourceRoot, "src"), join(appRoot, "src"), { recursive: true }),
    cp(join(sourceRoot, "public"), join(appRoot, "public"), { recursive: true }),
    writeFile(join(appRoot, "package.json"), JSON.stringify({
      name: "pyramid-map-refresh-fixture",
      private: true,
      type: "module",
      scripts: { verify: "bun run verify-fixture.ts" },
    })),
    writeFile(verificationPath, verificationSource),
  ])
  const tree = await readFile(join(sourceRoot, "maps/native-dsh-web-path/tree.json"), "utf8")
  await Promise.all([
    writeFile(join(mapRoot, "tree.json"), tree),
    writeFile(join(mapRoot, ".pyramid-map", "agent-base.json"), tree),
    writeFile(join(mapRoot, "verification.json"), '{"version":2,"updatedAt":null,"reviews":{}}\n'),
  ])
  return { appRoot, mapRoot, verificationPath }
}

function reservePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
  const selectedPort = probe.port
  probe.stop(true)
  return selectedPort
}

async function waitForIdentity(port: number, process_: ReturnType<typeof Bun.spawn>) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (process_.exitCode !== null) {
      const stderr = await new Response(process_.stderr).text()
      throw new Error(`Pyramid Map fixture exited before becoming ready: ${stderr}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return
    } catch {
      await Bun.sleep(20)
    }
  }
  throw new Error("Pyramid Map fixture did not become ready")
}

async function waitForFingerprint(port: number, fingerprint: string): Promise<{ pid: number }> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) {
        const body = await response.json() as { pid: number, runtimeFingerprint?: string }
        if (body.runtimeFingerprint === fingerprint) return body
      }
    } catch {}
    await Bun.sleep(20)
  }
  throw new Error("Fresh Pyramid Map runtime did not take ownership of the port")
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
