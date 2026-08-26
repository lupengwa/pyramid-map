import { join, resolve } from "node:path"

import { createDataStore, type DataStore } from "./data-store"

export interface MapStoreRegistry {
  get(mapDirectory?: string | null): Promise<DataStore>
}

export function createMapStoreRegistry(defaultMapDirectory: string): MapStoreRegistry {
  const stores = new Map<string, Promise<DataStore>>()
  const defaultDirectory = resolve(defaultMapDirectory)

  return {
    async get(mapDirectory) {
      const directory = resolve(mapDirectory ?? defaultDirectory)
      let pendingStore = stores.get(directory)
      if (pendingStore === undefined) {
        pendingStore = createDataStore({
          treePath: join(directory, "tree.json"),
          verificationPath: join(directory, "verification.json"),
          agentValidationPath: join(directory, "agent-validation.json"),
        })
        stores.set(directory, pendingStore)
      }

      try {
        return await pendingStore
      } catch (error) {
        if (stores.get(directory) === pendingStore) stores.delete(directory)
        throw error
      }
    },
  }
}
