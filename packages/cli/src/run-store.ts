import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  BookTranslationContext,
  CompileRunStore,
  StoredBatchTranslations,
  StoredChunkResult,
} from '@lexweave/compile'

/**
 * Filesystem checkpoint store for compile runs (novel-translator's runs/
 * directory, adapted): one subdirectory per fingerprint holding one JSON file
 * per COMPLETED unit of work, so an interrupted compile resumes from whatever
 * finished. Extraction and translation have independent fingerprints, so
 * their directories are namespaced apart and pruned per kind — a changed
 * glossary/model re-keys and clears only what it invalidates.
 *
 * Layout:
 *   <root>/x<fingerprint>/chunk-000003.json     extraction pass
 *   <root>/<fingerprint>/context.json           translation pass (book brief)
 *   <root>/<fingerprint>/batch-000042.json      translation pass
 */
export function createFileRunStore(rootDir: string): CompileRunStore {
  const loadNumberedJson = <T>(
    dir: string,
    filePattern: RegExp,
    pick: (parsed: any) => T | null
  ): Map<number, T> => {
    const items = new Map<number, T>()
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch {
      return items
    }
    for (const file of files) {
      const match = filePattern.exec(file)
      if (!match) {
        continue
      }
      try {
        const value = pick(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
        if (value != null) {
          items.set(Number(match[1]), value)
        }
      } catch {
        // A corrupt/truncated file (e.g. killed mid-write) just re-runs.
      }
    }
    return items
  }

  const saveNumberedJson = (dir: string, name: string, data: unknown): void => {
    fs.mkdirSync(dir, {recursive: true})
    writeAtomic(path.join(dir, name), JSON.stringify(data))
  }

  return {
    async loadChunks(fingerprint) {
      pruneStale(rootDir, `x${fingerprint}`, /^x[0-9a-f]{16}$/)
      return loadNumberedJson<StoredChunkResult>(
        path.join(rootDir, `x${fingerprint}`),
        /^chunk-(\d+)\.json$/,
        (parsed) => (Array.isArray(parsed?.units) ? parsed : null)
      )
    },

    async saveChunk(fingerprint, chunkIndex, result) {
      saveNumberedJson(
        path.join(rootDir, `x${fingerprint}`),
        `chunk-${String(chunkIndex).padStart(6, '0')}.json`,
        result
      )
    },

    async loadBatches(fingerprint) {
      pruneStale(rootDir, fingerprint, /^[0-9a-f]{16}$/)
      return loadNumberedJson<StoredBatchTranslations>(
        path.join(rootDir, fingerprint),
        /^batch-(\d+)\.json$/,
        (parsed) => (Array.isArray(parsed?.translations) ? parsed.translations : null)
      )
    },

    async saveBatch(fingerprint, batchIndex, translations) {
      saveNumberedJson(
        path.join(rootDir, fingerprint),
        `batch-${String(batchIndex).padStart(6, '0')}.json`,
        {translations}
      )
    },

    async loadContext(fingerprint) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(rootDir, fingerprint, 'context.json'), 'utf8')
        )
        return parsed && typeof parsed.synopsis === 'string'
          ? (parsed as BookTranslationContext)
          : null
      } catch {
        return null
      }
    },

    async saveContext(fingerprint, context) {
      saveNumberedJson(path.join(rootDir, fingerprint), 'context.json', context)
    },
  }
}

// write-then-rename so a killed process leaves either the old file or the new
// one, never a truncated JSON that would poison the next resume.
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

// Remove sibling fingerprint dirs OF THE SAME KIND (stale glossary/config).
// Only ever touches our own fingerprint-shaped names, so a user file
// accidentally placed under the runs dir survives.
function pruneStale(rootDir: string, keep: string, kindPattern: RegExp): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(rootDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry !== keep && kindPattern.test(entry)) {
      fs.rmSync(path.join(rootDir, entry), {recursive: true, force: true})
    }
  }
}
