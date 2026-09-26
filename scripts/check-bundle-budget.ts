import { promises as fs } from 'node:fs'
import * as path from 'node:path'

interface ChunkBudget {
  name: string
  pattern: RegExp
  maxBytes: number
  required?: boolean
}

const DIST_WEB_DIR = path.resolve(process.cwd(), 'dist/web')
const ASSETS_DIR = path.join(DIST_WEB_DIR, 'assets')
const INDEX_HTML_PATH = path.join(DIST_WEB_DIR, 'index.html')

const CHUNK_BUDGETS: ChunkBudget[] = [
  {
    name: 'main',
    pattern: /^main-[A-Za-z0-9_-]+\.js$/,
    maxBytes: 850 * 1024,
    required: true,
  },
  {
    name: 'vendor-react',
    pattern: /^vendor-react-[A-Za-z0-9_-]+\.js$/,
    maxBytes: 700 * 1024,
    required: true,
  },
  {
    name: 'vendor-radix',
    pattern: /^vendor-radix-[A-Za-z0-9_-]+\.js$/,
    maxBytes: 70 * 1024,
    required: true,
  },
  {
    name: 'vendor-code',
    pattern: /^vendor-code-[A-Za-z0-9_-]+\.js$/,
    maxBytes: 100 * 1024,
    required: false,
  },
]

function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KiB`
}

async function listJsChunks(assetsDir: string): Promise<string[]> {
  const entries = await fs.readdir(assetsDir)
  return entries.filter((entry) => entry.endsWith('.js'))
}

async function getChunkSizeBytes(assetsDir: string, chunkFile: string): Promise<number> {
  const stat = await fs.stat(path.join(assetsDir, chunkFile))
  return stat.size
}

async function ensureVendorCodeIsNotStartupCritical(mainChunkFile: string): Promise<string | null> {
  const mainChunkPath = path.join(ASSETS_DIR, mainChunkFile)
  const mainSource = await fs.readFile(mainChunkPath, 'utf8')
  if (/import\s*['\"]\.\/vendor-code-[^'\"]+\.js['\"];?/.test(mainSource)) {
    return `${mainChunkFile} statically imports vendor-code; code highlighting should stay lazy`
  }
  return null
}

async function ensureVendorCodeNotModulePreloaded(): Promise<string | null> {
  const indexHtml = await fs.readFile(INDEX_HTML_PATH, 'utf8')
  const preloadedVendorCode = /<link\s+rel=['\"]modulepreload['\"][^>]*href=['\"][^'\"]*vendor-code-[^'\"]+\.js['\"]/i.test(indexHtml)
  if (preloadedVendorCode) {
    return 'index.html modulepreloads vendor-code; code highlighting should load on demand'
  }
  return null
}

async function run(): Promise<void> {
  const failures: string[] = []
  const jsChunks = await listJsChunks(ASSETS_DIR)
  const measurements: Array<{ name: string; file: string; size: number; max: number }> = []

  for (const budget of CHUNK_BUDGETS) {
    const matchedChunk = jsChunks.find((chunk) => budget.pattern.test(chunk))

    if (!matchedChunk) {
      if (budget.required) {
        failures.push(`missing required chunk for budget '${budget.name}' (${budget.pattern.source})`)
      }
      continue
    }

    const chunkSize = await getChunkSizeBytes(ASSETS_DIR, matchedChunk)
    measurements.push({
      name: budget.name,
      file: matchedChunk,
      size: chunkSize,
      max: budget.maxBytes,
    })

    if (chunkSize > budget.maxBytes) {
      failures.push(
        `${budget.name} exceeds budget: ${formatKiB(chunkSize)} > ${formatKiB(budget.maxBytes)} (${matchedChunk})`,
      )
    }
  }

  const mainChunk = measurements.find((item) => item.name === 'main')
  if (mainChunk) {
    const startupCriticalFailure = await ensureVendorCodeIsNotStartupCritical(mainChunk.file)
    if (startupCriticalFailure) {
      failures.push(startupCriticalFailure)
    }
  }

  const preloadFailure = await ensureVendorCodeNotModulePreloaded()
  if (preloadFailure) {
    failures.push(preloadFailure)
  }

  for (const measurement of measurements) {
    console.log(
      `[bundle] ${measurement.name}: ${formatKiB(measurement.size)} / ${formatKiB(measurement.max)} (${measurement.file})`,
    )
  }

  if (failures.length > 0) {
    console.error('[bundle] Budget checks failed:')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exit(1)
  }

  console.log('[bundle] Budget checks passed')
}

run().catch((error) => {
  console.error('[bundle] Failed to evaluate bundle budgets')
  console.error(error)
  process.exit(1)
})
