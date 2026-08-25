import { join } from "node:path"

import { createDataStore } from "./src/data-store"
import { createHttpApp } from "./src/http-app"

const appRoot = import.meta.dir
const port = readPort(process.env.DSH_GWE_PORT)
const treePath = process.env.DSH_GWE_TREE_PATH ?? join(appRoot, "data/tree.json")
const verificationPath = process.env.DSH_GWE_VERIFICATION_PATH ?? join(appRoot, "data/verification.json")
const activityPath = process.env.DSH_GWE_ACTIVITY_PATH ?? join(appRoot, "data/activity.jsonl")

const dataStore = await createDataStore({
  treePath,
  verificationPath,
  activityPath,
})

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createHttpApp({
    dataStore,
    publicRoot: join(appRoot, "public"),
  }),
})

const appUrl = `http://${server.hostname}:${server.port}`
console.log(`DSH Web pyramid map is ready at ${appUrl}`)
console.log("Press Ctrl-C to stop it.")

if (Bun.argv.includes("--open")) {
  Bun.spawn(["open", appUrl], { stdout: "ignore", stderr: "ignore" })
}

function readPort(rawPort: string | undefined): number {
  if (rawPort === undefined) return 4318
  const parsed = Number(rawPort)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`DSH_GWE_PORT must be an integer from 1 to 65535, received: ${rawPort}`)
  }
  return parsed
}
