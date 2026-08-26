import { mkdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { readRuntimeIdentity, type RuntimeIdentity } from "./runtime-identity"

export const DEFAULT_SERVER_PORT = 4318

export interface OpenMapOptions {
  appRoot: string
  mapDirectory: string
  port?: number
  openBrowser?: boolean
  verifyBeforeStart?: boolean
}

export interface OpenMapResult {
  status: "started" | "reused" | "restarted"
  map: string
  url: string
}

type ServerHealth =
  | { state: "absent" | "occupied" }
  | { state: "pyramid-map", pid: number, appRoot?: string, runtimeFingerprint?: string }

export async function openMap({
  appRoot,
  mapDirectory,
  port = DEFAULT_SERVER_PORT,
  openBrowser = true,
  verifyBeforeStart = true,
}: OpenMapOptions): Promise<OpenMapResult> {
  const map = resolve(mapDirectory)
  const status = await ensureSharedServer({
    appRoot: resolve(appRoot),
    mapDirectory: map,
    port,
    verifyBeforeStart,
  })
  const url = createMapUrl(port, map)
  if (openBrowser) {
    const browser = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" })
    browser.unref()
  }
  return { status, map, url }
}

export function createMapUrl(port: number, mapDirectory: string): string {
  const url = new URL(`http://127.0.0.1:${port}/`)
  url.searchParams.set("map", resolve(mapDirectory))
  return url.toString()
}

export function readServerPort(rawPort: string | undefined): number {
  if (rawPort === undefined) return DEFAULT_SERVER_PORT
  const parsed = Number(rawPort)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`PYRAMID_MAP_PORT must be an integer from 1 to 65535, received: ${rawPort}`)
  }
  return parsed
}

export async function stopSharedServer(port = DEFAULT_SERVER_PORT): Promise<{ status: "not-running" | "stopped", port: number }> {
  const health = await readServerHealth(port)
  if (health.state === "absent") return { status: "not-running", port }
  if (health.state === "occupied") throw occupiedPortError(port)

  await terminatePyramidProcess(port, health.pid)
  return { status: "stopped", port }
}

async function ensureSharedServer({
  appRoot,
  mapDirectory,
  port,
  verifyBeforeStart,
}: {
  appRoot: string
  mapDirectory: string
  port: number
  verifyBeforeStart: boolean
}): Promise<"started" | "reused" | "restarted"> {
  const expectedIdentity = await readRuntimeIdentity(appRoot)
  const initialHealth = await readServerHealth(port)
  if (initialHealth.state === "occupied") throw occupiedPortError(port)
  if (matchesIdentity(initialHealth, expectedIdentity)) return "reused"

  const lockPath = `${tmpdir()}/pyramid-map-${port}.start.lock`
  const ownsLock = await acquireStartLock(lockPath, port, expectedIdentity)
  if (!ownsLock) return "reused"

  try {
    const currentHealth = await readServerHealth(port)
    if (currentHealth.state === "occupied") throw occupiedPortError(port)
    if (matchesIdentity(currentHealth, expectedIdentity)) return "reused"

    const replacingStaleRuntime = currentHealth.state === "pyramid-map"
    if (verifyBeforeStart) await runVerification(appRoot)
    if (currentHealth.state === "pyramid-map") {
      await terminatePyramidProcess(port, currentHealth.pid)
    }

    const process_ = Bun.spawn([process.execPath, "run", "server.ts", "--map", mapDirectory], {
      cwd: appRoot,
      env: { ...process.env, PYRAMID_MAP_PORT: String(port) },
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    process_.unref()

    await waitForExpectedServer(port, expectedIdentity, process_)
    return replacingStaleRuntime ? "restarted" : "started"
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

async function acquireStartLock(lockPath: string, port: number, expectedIdentity: RuntimeIdentity): Promise<boolean> {
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      await mkdir(lockPath)
      return true
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error
      const lockAge = Date.now() - (await stat(lockPath)).mtimeMs
      if (lockAge > 30_000) {
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      const health = await readServerHealth(port)
      if (matchesIdentity(health, expectedIdentity)) return false
      if (health.state === "occupied") throw occupiedPortError(port)
      if (Date.now() >= deadline) throw new Error("Another Pyramid Map launcher did not finish starting the shared server")
      await Bun.sleep(50)
    }
  }
}

async function waitForExpectedServer(
  port: number,
  expectedIdentity: RuntimeIdentity,
  process_: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const health = await readServerHealth(port)
    if (matchesIdentity(health, expectedIdentity)) return
    if (health.state === "occupied") throw occupiedPortError(port)
    if (health.state === "pyramid-map") {
      throw new Error(`A different Pyramid Map runtime claimed port ${port} while the current runtime was starting`)
    }
    if (process_.exitCode !== null) throw new Error("The shared Pyramid Map server exited before becoming ready")
    await Bun.sleep(25)
  }
  throw new Error(`The shared Pyramid Map server did not become ready on port ${port}`)
}

async function terminatePyramidProcess(port: number, pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    if (!isErrorCode(error, "ESRCH")) throw error
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const health = await readServerHealth(port)
    if (health.state === "absent") return
    if (health.state === "occupied") throw occupiedPortError(port)
    if (health.pid !== pid) {
      throw new Error(`Another Pyramid Map process claimed port ${port} before the previous process released it`)
    }
    await Bun.sleep(25)
  }
  throw new Error(`The shared Pyramid Map server on port ${port} did not stop`)
}

async function runVerification(appRoot: string): Promise<void> {
  const verification = Bun.spawn([process.execPath, "run", "verify"], {
    cwd: appRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await verification.exited !== 0) throw new Error("Pyramid Map verification failed, so the shared server was not started")
}

async function readServerHealth(port: number): Promise<ServerHealth> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(300),
    })
    if (!response.ok) return { state: "occupied" }
    const body = await response.json().catch(() => null)
    return isPyramidMapHealth(body)
      ? {
        state: "pyramid-map",
        pid: body.pid,
        appRoot: typeof body.appRoot === "string" ? body.appRoot : undefined,
        runtimeFingerprint: typeof body.runtimeFingerprint === "string" ? body.runtimeFingerprint : undefined,
      }
      : { state: "occupied" }
  } catch {
    return { state: "absent" }
  }
}

function matchesIdentity(health: ServerHealth, expected: RuntimeIdentity): boolean {
  return health.state === "pyramid-map"
    && health.appRoot === expected.appRoot
    && health.runtimeFingerprint === expected.fingerprint
}

function isPyramidMapHealth(value: unknown): value is {
  ok: true
  app: "pyramid-map"
  pid: number
  appRoot?: unknown
  runtimeFingerprint?: unknown
} {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true
    && "app" in value && value.app === "pyramid-map"
    && "pid" in value && typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
}

function occupiedPortError(port: number): Error {
  return new Error(`Port ${port} is occupied by another service. Set PYRAMID_MAP_PORT to one free port for the shared Pyramid Map server.`)
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
