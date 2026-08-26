import type { RuntimeIdentity } from "./runtime-identity"
import { readRuntimeIdentity } from "./runtime-identity"

interface RuntimeRefreshOptions {
  appRoot: string
  mapDirectory: string
  port: number
  startupIdentity: RuntimeIdentity
  scheduleStop(): void
}

type RefreshOutcome =
  | { status: "updating", identity: RuntimeIdentity }
  | { status: "failed", identity: RuntimeIdentity, message: string }

export function createRuntimeRefreshGuard(options: RuntimeRefreshOptions) {
  let refresh: Promise<RefreshOutcome> | undefined
  let targetFingerprint: string | undefined
  let failed: RefreshOutcome & { status: "failed" } | undefined

  return async function guard(request: Request): Promise<Response | null> {
    const url = new URL(request.url)
    if (url.pathname === "/healthz") return null

    const currentIdentity = await readRuntimeIdentity(options.appRoot)
    if (currentIdentity.fingerprint === options.startupIdentity.fingerprint) return null

    if (failed?.identity.fingerprint === currentIdentity.fingerprint) {
      if (url.pathname !== "/") return failedResponse(request, failed.message)
      failed = undefined
      refresh = undefined
    }
    if (refresh === undefined || targetFingerprint !== currentIdentity.fingerprint) {
      targetFingerprint = currentIdentity.fingerprint
      refresh = replaceRuntime(options, currentIdentity)
    }

    const outcome = await refresh
    if (outcome.status === "failed") {
      failed = outcome
      return failedResponse(request, outcome.message)
    }
    return updatingResponse(request, outcome.identity.fingerprint)
  }
}

export async function waitForReplacedProcess(rawPid: string | undefined): Promise<void> {
  if (rawPid === undefined) return
  const pid = Number(rawPid)
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) {
    throw new Error(`PYRAMID_MAP_REPLACE_PID must identify another process, received: ${rawPid}`)
  }
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (!isProcessRunning(pid)) return
    await Bun.sleep(50)
  }
  throw new Error(`The previous Pyramid Map process ${pid} did not release the port`)
}

async function replaceRuntime(options: RuntimeRefreshOptions, identity: RuntimeIdentity): Promise<RefreshOutcome> {
  try {
    await runVerification(options.appRoot)
    const verifiedIdentity = await readRuntimeIdentity(options.appRoot)
    const replacement = Bun.spawn([
      process.execPath,
      "run",
      "server.ts",
      "--map",
      options.mapDirectory,
    ], {
      cwd: options.appRoot,
      env: {
        ...process.env,
        PYRAMID_MAP_PORT: String(options.port),
        PYRAMID_MAP_REPLACE_PID: String(process.pid),
      },
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    replacement.unref()
    await Bun.sleep(50)
    if (replacement.exitCode !== null) throw new Error("The replacement Pyramid Map process exited before handoff")
    options.scheduleStop()
    return { status: "updating", identity: verifiedIdentity }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runtime verification failure"
    console.error(`Pyramid Map runtime refresh failed: ${message}`)
    return { status: "failed", identity, message }
  }
}

async function runVerification(appRoot: string): Promise<void> {
  const verification = Bun.spawn([process.execPath, "run", "verify"], {
    cwd: appRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await verification.exited !== 0) throw new Error("Updated Pyramid Map verification failed. The current server remains active.")
}

function updatingResponse(request: Request, fingerprint: string): Response {
  if (!acceptsHtml(request)) {
    return Response.json({
      error: "Pyramid Map is updating to the latest verified runtime",
      runtimeFingerprint: fingerprint,
    }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "1" } })
  }
  const expectedFingerprint = JSON.stringify(fingerprint)
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Updating Pyramid Map</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; background: #f5f3ee; color: #1e2420; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
    main { width: min(32rem, calc(100% - 3rem)); padding: 2rem; border: 2px solid #235ea7; border-radius: 1rem; background: white; box-shadow: 0 1rem 3rem #1e24201f; }
    .signal { width: 0.75rem; height: 0.75rem; border-radius: 50%; background: #235ea7; animation: pulse 1s ease-in-out infinite alternate; }
    h1 { margin: 1rem 0 0.5rem; font-size: 1.5rem; }
    p { margin: 0; color: #536058; }
    @keyframes pulse { to { opacity: 0.25; transform: scale(0.75); } }
  </style>
</head>
<body>
  <main role="status" aria-live="polite">
    <div class="signal" aria-hidden="true"></div>
    <h1>Updating Pyramid Map</h1>
    <p>The changed code passed verification. This page will reload when the fresh runtime is ready.</p>
  </main>
  <script>
    const expected = ${expectedFingerprint};
    const check = async () => {
      try {
        const response = await fetch('/healthz', { cache: 'no-store' });
        const health = await response.json();
        if (health.runtimeFingerprint === expected) return location.reload();
      } catch {}
      setTimeout(check, 150);
    };
    setTimeout(check, 150);
  </script>
</body>
</html>`, {
    status: 200,
    headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
  })
}

function failedResponse(request: Request, message: string): Response {
  if (!acceptsHtml(request)) {
    return Response.json({ error: message }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    })
  }
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pyramid Map update failed</title></head><body><main><h1>Pyramid Map update failed</h1><p>${escapeHtml(message)}</p><p>The previous runtime is still active. Fix the verification failure, then refresh again.</p></main></body></html>`, {
    status: 503,
    headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
  })
}

function acceptsHtml(request: Request): boolean {
  return new URL(request.url).pathname === "/" || request.headers.get("accept")?.includes("text/html") === true
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isErrorCode(error, "ESRCH")
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
