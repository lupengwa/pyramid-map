import { basename, join, resolve } from "node:path"

import { createHttpApp } from "./src/http-app"
import { createMapStoreRegistry } from "./src/map-store-registry"
import { readRuntimeIdentity } from "./src/runtime-identity"
import { createRuntimeRefreshGuard, waitForReplacedProcess } from "./src/runtime-refresh"
import { createMapUrl, readServerPort } from "./src/shared-server"

const appRoot = import.meta.dir
const mapDirectory = readMapDirectory(Bun.argv.slice(2))
const port = readServerPort(process.env.PYRAMID_MAP_PORT ?? process.env.DSH_GWE_PORT)
await waitForReplacedProcess(process.env.PYRAMID_MAP_REPLACE_PID)
const runtimeIdentity = await readRuntimeIdentity(appRoot)
const stores = createMapStoreRegistry(mapDirectory)
let server: ReturnType<typeof Bun.serve>
const runtimeRefresh = createRuntimeRefreshGuard({
  appRoot,
  mapDirectory,
  port,
  startupIdentity: runtimeIdentity,
  scheduleStop() {
    setTimeout(() => {
      server.stop(true)
      process.exit(0)
    }, 250)
  },
})

server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createHttpApp({
    getDataStore: (selectedMap) => stores.get(selectedMap),
    publicRoot: join(appRoot, "public"),
    runtimeIdentity,
    beforeRequest: runtimeRefresh,
  }),
})

const appUrl = createMapUrl(server.port, mapDirectory)
console.log(`Shared Pyramid Map server is ready at http://${server.hostname}:${server.port}`)
console.log(`${basename(mapDirectory)} opens at ${appUrl}`)
console.log("Press Ctrl-C to stop it.")

if (Bun.argv.includes("--open")) {
  Bun.spawn(["open", appUrl], { stdout: "ignore", stderr: "ignore" })
}

function readMapDirectory(args: string[]): string {
  const mapIndex = args.indexOf("--map")
  const rawPath = mapIndex === -1 ? process.env.PYRAMID_MAP_DIR : args[mapIndex + 1]
  if (mapIndex !== -1 && (rawPath === undefined || rawPath.startsWith("--"))) {
    throw new Error("--map requires a presentation directory")
  }
  return resolve(rawPath ?? join(appRoot, "maps", "native-dsh-web-path"))
}
