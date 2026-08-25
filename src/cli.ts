import { encode } from "@toon-format/toon"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { createDataStore, type MapSnapshot } from "./data-store"
import { compareMaps, type MapDifference } from "./map-diff"
import { parseMapDocument, type GweNode } from "./model"
import { openMap, readServerPort, stopSharedServer } from "./shared-server"

const HELP = {
  bin: "pyramid-map",
  description: "Open or inspect a shared pyramid map and compare it with the agent baseline",
  usage: "pyramid-map [--map PATH] <command> [options]",
  commands: [
    "open [--port PORT] [--no-browser]   Reuse one server and open this map in its own tab",
    "stop [--port PORT]                  Stop the shared local server",
    "read [--full]       Read the current map",
    "view NODE_ID        Read one complete current node",
    "diff [--full]       Compare tree.json with .pyramid-map/agent-base.json",
  ],
  notes: [
    "Every open map shares one local server and keeps its destination directory as its durable state.",
    "The browser writes tree.json only.",
    "An agent reads the diff, edits tree.json, validates it, then writes identical JSON to agent-base.json.",
  ],
}

export async function main(rawArguments: string[]): Promise<number> {
  try {
    const { arguments_: args, mapDir } = parseGlobalArguments(rawArguments)
    if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") return succeed(HELP)

    const command = args.shift() ?? "read"
    if (command === "open") {
      if (takeBooleanFlag(args, "--help")) {
        assertNoArguments(args)
        return succeed({
          usage: "pyramid-map --map PATH open [--port PORT] [--no-browser]",
          flags: ["--map PATH (required for generated maps)", "--port PORT (default 4318)", "--no-browser"],
        })
      }
      const port = readServerPort(takeOptionalFlag(args, "--port") ?? process.env.PYRAMID_MAP_PORT)
      const openBrowser = !takeBooleanFlag(args, "--no-browser")
      assertNoArguments(args)
      return succeed(await openMap({
        appRoot: join(import.meta.dir, ".."),
        mapDirectory: mapDir,
        port,
        openBrowser,
      }))
    }
    if (command === "stop") {
      const port = readServerPort(takeOptionalFlag(args, "--port") ?? process.env.PYRAMID_MAP_PORT)
      assertNoArguments(args)
      return succeed(await stopSharedServer(port))
    }

    const treePath = join(mapDir, "tree.json")
    const verificationPath = join(mapDir, "verification.json")
    const agentBasePath = join(mapDir, ".pyramid-map", "agent-base.json")
    const store = await createDataStore({ treePath, verificationPath })
    if (command === "read") {
      const full = takeBooleanFlag(args, "--full")
      assertNoArguments(args)
      const snapshot = store.getSnapshot()
      const comparison = await readComparison(treePath, agentBasePath)
      return succeed(full ? { ...snapshot, agentBaseInSync: comparison.inSync } : summarizeSnapshot(snapshot, comparison.differences.length))
    }

    if (command === "view") {
      const nodeId = takePositional(args, "view requires NODE_ID")
      assertNoArguments(args)
      const snapshot = store.getSnapshot()
      const node = findNode(snapshot.tree, nodeId)
      if (node === null) throw new RuntimeError(`Unknown map node: ${nodeId}`)
      return succeed({ revision: snapshot.revision, node })
    }

    if (command === "diff") {
      const full = takeBooleanFlag(args, "--full")
      assertNoArguments(args)
      const comparison = await readComparison(treePath, agentBasePath)
      return succeed({
        inSync: comparison.inSync,
        differenceCount: comparison.differences.length,
        differences: full ? comparison.differences : comparison.differences.map(summarizeDifference),
      })
    }

    throw new UsageError(`Unknown command: ${command}`)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Unknown pyramid-map failure", error instanceof UsageError ? 2 : 1)
  }
}

function parseGlobalArguments(rawArguments: string[]): { arguments_: string[], mapDir: string } {
  const args = [...rawArguments]
  const explicitMap = takeOptionalFlag(args, "--map") ?? takeOptionalFlag(args, "--data-dir")
  const defaultMap = join(import.meta.dir, "..", "maps", "native-dsh-web-path")
  return { arguments_: args, mapDir: explicitMap ?? process.env.PYRAMID_MAP_DIR ?? defaultMap }
}

async function readComparison(treePath: string, agentBasePath: string) {
  const [treeSource, baseSource] = await Promise.all([
    readFile(treePath, "utf8"),
    readFile(agentBasePath, "utf8").catch((error) => {
      throw new RuntimeError(`Cannot read agent baseline at ${agentBasePath}: ${error instanceof Error ? error.message : "unknown error"}`)
    }),
  ])
  const current = parseMapDocument(JSON.parse(treeSource)).root
  const base = parseMapDocument(JSON.parse(baseSource)).root
  return compareMaps(base, current)
}

function summarizeSnapshot(snapshot: MapSnapshot, differenceCount: number) {
  return {
    bin: "pyramid-map",
    description: "Current shared pyramid map. Run `pyramid-map diff --full` before agent edits.",
    revision: snapshot.revision,
    agentBaseInSync: differenceCount === 0,
    differenceCount,
    verified: Object.keys(snapshot.verification.verified).length,
    nodes: flattenNodes(snapshot.tree).map(summarizeNode),
  }
}

function summarizeNode(node: GweNode) {
  return {
    id: node.id,
    title: node.title,
    pattern: node.pattern,
    style: node.style,
    sectionLabels: node.sections.map((section) => section.label),
    childIds: (node.children ?? []).map((child) => child.id),
  }
}

function summarizeDifference(difference: MapDifference) {
  if (difference.type === "update") return { type: difference.type, nodeId: difference.nodeId, fields: difference.fields }
  if (difference.type === "move") return difference
  return { type: difference.type, nodeId: difference.nodeId, parentId: difference.parentId, title: difference.type === "add" ? difference.after.title : difference.before.title }
}

function flattenNodes(root: GweNode): GweNode[] {
  return [root, ...(root.children ?? []).flatMap(flattenNodes)]
}

function findNode(root: GweNode, id: string): GweNode | null {
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const match = findNode(child, id)
    if (match !== null) return match
  }
  return null
}

function takeBooleanFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name)
  if (index === -1) return false
  args.splice(index, 1)
  return true
}

function takeOptionalFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  if (index === args.length - 1 || args[index + 1].startsWith("--")) throw new UsageError(`${name} requires a value`)
  return args.splice(index, 2)[1]
}

function takePositional(args: string[], message: string): string {
  if (args.length === 0 || args[0].startsWith("--")) throw new UsageError(message)
  return args.shift()!
}

function assertNoArguments(args: string[]): void {
  if (args.length > 0) throw new UsageError(`Unexpected argument: ${args[0]}`)
}

function succeed(value: unknown): number {
  process.stdout.write(`${encode(value)}\n`)
  return 0
}

function fail(message: string, code: 1 | 2): number {
  process.stdout.write(`${encode({ error: message, help: "Run `pyramid-map help` for usage." })}\n`)
  return code
}

class UsageError extends Error {}
class RuntimeError extends Error {}
