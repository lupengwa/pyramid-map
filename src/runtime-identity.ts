import { createHash } from "node:crypto"
import { readdir, readFile, realpath } from "node:fs/promises"
import { join, relative } from "node:path"

export interface RuntimeIdentity {
  appRoot: string
  fingerprint: string
}

const runtimeEntries = ["server.ts", "src", "public", "package.json", "bun.lock"] as const

export async function readRuntimeIdentity(appRoot: string): Promise<RuntimeIdentity> {
  const canonicalRoot = await realpath(appRoot)
  const files = (await Promise.all(runtimeEntries.map((entry) => collectFiles(join(canonicalRoot, entry))))).flat().sort()
  const hash = createHash("sha256")
  for (const filePath of files) {
    hash.update(relative(canonicalRoot, filePath))
    hash.update("\0")
    hash.update(await readFile(filePath))
    hash.update("\0")
  }
  return { appRoot: canonicalRoot, fingerprint: hash.digest("hex") }
}

async function collectFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) return null
    throw error
  })
  if (entries === null) {
    try {
      await readFile(path)
      return [path]
    } catch (error) {
      if (isErrorCode(error, "ENOENT") || isErrorCode(error, "EISDIR")) return []
      throw error
    }
  }
  return (await Promise.all(entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => collectFiles(join(path, entry.name))))).flat()
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
