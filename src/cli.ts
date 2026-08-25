import { decode, encode } from "@toon-format/toon"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { createDataStore, type MapActivity, type MutationActor } from "./data-store"
import type { GweNode } from "./model"

const HELP = {
  bin: "pyramid-map",
  description: "Read and safely update a shared human-agent pyramid map",
  usage: "pyramid-map [--data-dir PATH] <command> [options]",
  commands: [
    "read [--full]                         Read the latest revision and map",
    "view NODE_ID [--full]                 Read one latest node",
    "changes --since REV [--actor human]   Read edits after a known revision",
    "update NODE_ID --input FILE --expected-revision REV",
    "add-child PARENT_ID --input FILE --expected-revision REV",
    "remove NODE_ID --confirm NODE_ID --expected-revision REV",
  ],
  notes: [
    "Output is TOON on stdout. Mutation input can be JSON or TOON; use - for stdin.",
    "Agent mutations require the latest revision so newer human edits cannot be overwritten.",
  ],
}

export async function main(rawArguments: string[]): Promise<number> {
  try {
    const { arguments_: args, dataDir } = parseGlobalArguments(rawArguments)
    if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") return succeed(HELP)

    const store = await createDataStore({
      treePath: join(dataDir, "tree.json"),
      verificationPath: join(dataDir, "verification.json"),
      activityPath: join(dataDir, "activity.jsonl"),
    })
    const command = args.shift() ?? "read"

    if (command === "read") {
      const full = takeBooleanFlag(args, "--full")
      assertNoArguments(args)
      const snapshot = store.getSnapshot()
      return succeed(full ? snapshot : summarizeSnapshot(snapshot))
    }

    if (command === "view") {
      const nodeId = takePositional(args, "view requires NODE_ID")
      const full = takeBooleanFlag(args, "--full")
      assertNoArguments(args)
      const snapshot = store.getSnapshot()
      const node = findNode(snapshot.tree, nodeId)
      if (node === null) throw new RuntimeError(`Unknown map node: ${nodeId}`)
      return succeed({ revision: snapshot.revision, node: full ? node : summarizeNode(node) })
    }

    if (command === "changes") {
      const since = parseRevision(takeRequiredFlag(args, "--since"), "--since")
      const actor = takeOptionalFlag(args, "--actor")
      const full = takeBooleanFlag(args, "--full")
      assertNoArguments(args)
      if (actor !== undefined && actor !== "human" && actor !== "agent") throw new UsageError("--actor must be human or agent")
      const changes = store.getActivities(since, actor as MutationActor | undefined)
      return succeed({
        revision: store.getSnapshot().revision,
        since,
        changes: full ? changes : changes.map(summarizeActivity),
      })
    }

    if (command === "update") {
      const nodeId = takePositional(args, "update requires NODE_ID")
      const inputPath = takeRequiredFlag(args, "--input")
      const expectedRevision = parseRevision(takeRequiredFlag(args, "--expected-revision"), "--expected-revision")
      assertNoArguments(args)
      const result = await store.updateNode(nodeId, await readInput(inputPath), { actor: "agent", expectedRevision })
      return succeed({ ok: true, action: "update", nodeId, revision: result.revision })
    }

    if (command === "add-child") {
      const parentId = takePositional(args, "add-child requires PARENT_ID")
      const inputPath = takeRequiredFlag(args, "--input")
      const expectedRevision = parseRevision(takeRequiredFlag(args, "--expected-revision"), "--expected-revision")
      assertNoArguments(args)
      const result = await store.addChild(parentId, await readInput(inputPath), { actor: "agent", expectedRevision })
      return succeed({ ok: true, action: "add", parentId, nodeId: result.nodeId, revision: result.revision })
    }

    if (command === "remove") {
      const nodeId = takePositional(args, "remove requires NODE_ID")
      const confirmation = takeRequiredFlag(args, "--confirm")
      const expectedRevision = parseRevision(takeRequiredFlag(args, "--expected-revision"), "--expected-revision")
      assertNoArguments(args)
      if (confirmation !== nodeId) throw new UsageError("--confirm must exactly match NODE_ID")
      const result = await store.removeNode(nodeId, { actor: "agent", expectedRevision })
      return succeed({ ok: true, action: "remove", nodeId, parentId: result.parentId, removedIds: result.removedIds, revision: result.revision })
    }

    throw new UsageError(`Unknown command: ${command}`)
  } catch (error) {
    const isUsage = error instanceof UsageError
    return fail(error instanceof Error ? error.message : "Unknown pyramid-map failure", isUsage ? 2 : 1)
  }
}

function parseGlobalArguments(rawArguments: string[]): { arguments_: string[], dataDir: string } {
  const args = [...rawArguments]
  const explicitDataDir = takeOptionalFlag(args, "--data-dir")
  const defaultDataDir = join(import.meta.dir, "..", "data")
  return { arguments_: args, dataDir: explicitDataDir ?? process.env.DSH_GWE_DATA_DIR ?? defaultDataDir }
}

function summarizeSnapshot(snapshot: ReturnType<Awaited<ReturnType<typeof createDataStore>>["getSnapshot"]>) {
  return {
    bin: "pyramid-map",
    description: "Latest shared pyramid map. Run `pyramid-map help` for mutation commands.",
    revision: snapshot.revision,
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

function summarizeActivity(activity: MapActivity) {
  const { before: _before, after: _after, ...summary } = activity
  return summary
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

async function readInput(path: string): Promise<unknown> {
  const source = path === "-" ? await readFile(0, "utf8") : await readFile(path, "utf8")
  try {
    return path.endsWith(".toon") ? decode(source) : JSON.parse(source)
  } catch (error) {
    throw new UsageError(`Cannot parse ${path === "-" ? "stdin" : path}: ${error instanceof Error ? error.message : "invalid input"}`)
  }
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

function takeRequiredFlag(args: string[], name: string): string {
  const value = takeOptionalFlag(args, name)
  if (value === undefined) throw new UsageError(`${name} is required`)
  return value
}

function takePositional(args: string[], message: string): string {
  if (args.length === 0 || args[0].startsWith("--")) throw new UsageError(message)
  return args.shift()!
}

function parseRevision(value: string, flag: string): number {
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision < 0) throw new UsageError(`${flag} must be a non-negative integer`)
  return revision
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
