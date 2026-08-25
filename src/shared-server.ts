import { mkdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

export const DEFAULT_SERVER_PORT = 4318

export interface OpenMapOptions {
  appRoot: string
  mapDirectory: string
  port?: number
  openBrowser?: boolean
  verifyBeforeStart?: boolean
}

export interface OpenMapResult {
  status: "started" | "reused"
  map: string
  url: string
}

type ServerProbe = "absent" | "occupied" | "ready"
type ServerHealth = { state: "absent" | "occupied" } | { state: "ready", pid: number }

export async function openMap({
  appRoot,
  mapDirectory,
  port = DEFAULT_SERVER_PORT,
  openBrowser = true,
  verifyBeforeStart = true,
}: OpenMapOptions): Promise<OpenMapResult> {
  const map = resolve(mapDirectory)
  const status = await ensureSharedServer({ appRoot: resolve(appRoot), port, verifyBeforeStart })
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

  try {
    process.kill(health.pid, "SIGTERM")
  } catch (error) {
    if (!isErrorCode(error, "ESRCH")) throw error
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readServerHealth(port)).state === "absent") return { status: "stopped", port }
    await Bun.sleep(25)
  }
  throw new Error(`The shared Pyramid Map server on port ${port} did not stop`)
}

async function ensureSharedServer({
  appRoot,
  port,
  verifyBeforeStart,
}: {
  appRoot: string
  port: number
  verifyBeforeStart: boolean
}): Promise<"started" | "reused"> {
  const initialProbe = await probeServer(port)
  if (initialProbe === "ready") return "reused"
  if (initialProbe === "occupied") throw occupiedPortError(port)

  const lockPath = `${tmpdir()}/pyramid-map-${port}.start.lock`
  const ownsLock = await acquireStartLock(lockPath, port)
  if (!ownsLock) return "reused"

  try {
    const secondProbe = await probeServer(port)
    if (secondProbe === "ready") return "reused"
    if (secondProbe === "occupied") throw occupiedPortError(port)

    if (verifyBeforeStart) await runVerification(appRoot)
    const process_ = Bun.spawn([process.execPath, "run", "server.ts"], {
      cwd: appRoot,
      env: { ...process.env, PYRAMID_MAP_PORT: String(port) },
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    process_.unref()

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = await probeServer(port)
      if (probe === "ready") return "started"
      if (probe === "occupied") throw occupiedPortError(port)
      if (process_.exitCode !== null) throw new Error("The shared Pyramid Map server exited before becoming ready")
      await Bun.sleep(25)
    }
    throw new Error(`The shared Pyramid Map server did not become ready on port ${port}`)
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}

async function acquireStartLock(lockPath: string, port: number): Promise<boolean> {
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
      const probe = await probeServer(port)
      if (probe === "ready") return false
      if (probe === "occupied") throw occupiedPortError(port)
      if (Date.now() >= deadline) throw new Error("Another Pyramid Map launcher did not finish starting the shared server")
      await Bun.sleep(50)
    }
  }
}

async function runVerification(appRoot: string): Promise<void> {
  const verification = Bun.spawn([process.execPath, "run", "verify"], {
    cwd: appRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await verification.exited !== 0) throw new Error("Pyramid Map verification failed, so the shared server was not started")
}

async function probeServer(port: number): Promise<ServerProbe> {
  return (await readServerHealth(port)).state
}

async function readServerHealth(port: number): Promise<ServerHealth> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(300),
    })
    if (!response.ok) return { state: "occupied" }
    const body = await response.json().catch(() => null)
    return isPyramidMapHealth(body) ? { state: "ready", pid: body.pid } : { state: "occupied" }
  } catch {
    return { state: "absent" }
  }
}

function isPyramidMapHealth(value: unknown): value is { ok: true, app: "pyramid-map", pid: number } {
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
