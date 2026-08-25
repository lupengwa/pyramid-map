import { join } from "node:path"

import { openMap } from "../../src/shared-server"

const mapDirectory = process.argv[2]
const port = Number(process.argv[3])
if (mapDirectory === undefined || !Number.isInteger(port)) throw new Error("open-map fixture requires MAP_DIRECTORY PORT")

const result = await openMap({
  appRoot: join(import.meta.dir, "../.."),
  mapDirectory,
  port,
  openBrowser: false,
  verifyBeforeStart: false,
})
process.stdout.write(`${JSON.stringify(result)}\n`)
