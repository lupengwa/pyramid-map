import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readRuntimeIdentity } from "../src/runtime-identity"

describe("Pyramid Map runtime identity", () => {
  test("changes only when production runtime files change", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pyramid-map-identity-"))
    try {
      await Promise.all([
        mkdir(join(appRoot, "src"), { recursive: true }),
        mkdir(join(appRoot, "public"), { recursive: true }),
        mkdir(join(appRoot, "maps", "example"), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(appRoot, "server.ts"), "console.log('server')\n"),
        writeFile(join(appRoot, "src", "runtime.ts"), "export const runtime = 1\n"),
        writeFile(join(appRoot, "public", "app.js"), "console.log('browser')\n"),
        writeFile(join(appRoot, "package.json"), '{"type":"module"}\n'),
        writeFile(join(appRoot, "bun.lock"), "lockfile\n"),
        writeFile(join(appRoot, "maps", "example", "tree.json"), '{"revision":1}\n'),
      ])

      const initial = await readRuntimeIdentity(appRoot)
      const unchanged = await readRuntimeIdentity(appRoot)
      expect(unchanged).toEqual(initial)

      await writeFile(join(appRoot, "maps", "example", "tree.json"), '{"revision":2}\n')
      expect(await readRuntimeIdentity(appRoot)).toEqual(initial)

      await writeFile(join(appRoot, "public", "app.js"), "console.log('new browser')\n")
      const changed = await readRuntimeIdentity(appRoot)
      expect(changed.appRoot).toBe(initial.appRoot)
      expect(changed.fingerprint).not.toBe(initial.fingerprint)
    } finally {
      await rm(appRoot, { recursive: true, force: true })
    }
  })
})
