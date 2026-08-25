import { join } from "node:path"

import type { DataStore } from "./data-store"
import { parseEditableNode } from "./model"

interface HttpAppOptions {
  getDataStore(mapDirectory?: string | null): Promise<DataStore>
  publicRoot: string
}

const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/map-model.js", ["map-model.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
] as const)

export function createHttpApp({ getDataStore, publicRoot }: HttpAppOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url)

      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, app: "pyramid-map", pid: process.pid })
      }
      if (url.pathname.startsWith("/api/")) {
        const dataStore = await getDataStore(url.searchParams.get("map"))
        await dataStore.refresh()
        return handleApiRequest(request, url, dataStore)
      }

      const staticFile = staticFiles.get(url.pathname)
      if (request.method === "GET" && staticFile !== undefined) {
        const [fileName, contentType] = staticFile
        const file = Bun.file(join(publicRoot, fileName))
        if (!(await file.exists())) return new Response("Not found", { status: 404 })
        return new Response(file, {
          headers: {
            "cache-control": "no-store",
            "content-type": contentType,
          },
        })
      }

      return new Response("Not found", { status: 404 })
    } catch (error) {
      console.error(error)
      return json({ error: "The app could not complete that request" }, 500)
    }
  }
}

async function handleApiRequest(request: Request, url: URL, dataStore: DataStore): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/map") {
    return json(dataStore.getSnapshot())
  }
  if (request.method === "GET" && url.pathname === "/api/tree") {
    return json(dataStore.getTree())
  }

  const childMutationMatch = url.pathname.match(/^\/api\/tree\/([^/]+)\/children$/)
  if (request.method === "POST" && childMutationMatch !== null) {
    const parentId = decodeURIComponent(childMutationMatch[1])
    if (!dataStore.hasNode(parentId)) return json({ error: `Unknown GWE node: ${parentId}` }, 404)
    const content = await readEditableContent(request)
    if (content instanceof Response) return content
    return json(await dataStore.addChild(parentId, content), 201)
  }

  const treeMutationMatch = url.pathname.match(/^\/api\/tree\/([^/]+)$/)
  if (treeMutationMatch !== null) {
    const id = decodeURIComponent(treeMutationMatch[1])
    if (!dataStore.hasNode(id)) return json({ error: `Unknown GWE node: ${id}` }, 404)
    if (request.method === "PUT") {
      const content = await readEditableContent(request)
      if (content instanceof Response) return content
      return json(await dataStore.updateNode(id, content))
    }
    if (request.method === "DELETE") {
      if (id === dataStore.getTree().id) return json({ error: "The proof tree root cannot be removed" }, 400)
      return json(await dataStore.removeNode(id))
    }
  }

  if (request.method === "GET" && url.pathname === "/api/verification") {
    return json(dataStore.getVerification())
  }
  if (request.method === "DELETE" && url.pathname === "/api/verification") {
    return json(await dataStore.resetVerification())
  }

  const verificationMatch = url.pathname.match(/^\/api\/verification\/([^/]+)$/)
  if (request.method === "PUT" && verificationMatch !== null) {
    const id = decodeURIComponent(verificationMatch[1])
    if (!dataStore.hasNode(id)) return json({ error: `Unknown GWE node: ${id}` }, 404)
    const body = await request.json().catch(() => null)
    if (!isVerificationUpdate(body)) return json({ error: "Body must be { verified: boolean }" }, 400)
    return json(await dataStore.setVerified(id, body.verified))
  }

  return new Response("Not found", { status: 404 })
}

async function readEditableContent(request: Request) {
  const body = await request.json().catch(() => null)
  try {
    return parseEditableNode(body)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid editable GWE content" }, 400)
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

function isVerificationUpdate(value: unknown): value is { verified: boolean } {
  return typeof value === "object" && value !== null && "verified" in value && typeof value.verified === "boolean"
}
