import * as fs from 'node:fs'
import * as path from 'node:path'
import {EnvHttpProxyAgent, setGlobalDispatcher} from 'undici'

// Node's fetch ignores http(s)_proxy env vars (curl honors them). Providers
// are unreachable directly in proxied environments, so route fetch through
// the same proxy the shell uses whenever one is configured.
if (
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY
) {
  setGlobalDispatcher(new EnvHttpProxyAgent())
}
import {
  createDocumentFromPlainText,
  createReadingMemory,
  expressionsFromAssets,
  parseBookBundle,
  planReplacements,
  type BookBundle,
  type ContentDocument,
  type ReadingSessionState,
} from '@lexweave/core'
import {compileText, type CompileProgress} from '@lexweave/compile'
import {
  createReplacementEngine,
  densityRenderOptions,
  escapeHtml,
  plainMatchRenderer,
  type ReplacementEngine,
} from '@lexweave/render'
import {ANTHROPIC_DEFAULT_MODEL, createAnthropicLlm} from './providers/anthropic'
import {createMockLlm, type MockGlossaryEntry} from './providers/mock'
import {createOpenAiLlm, OPENAI_DEFAULT_MODEL} from './providers/openai'
import {createFileRunStore} from './run-store'

const HELP = `lexweave — compile long-form text into a progressively bilingual learning edition

USAGE
  lexweave compile <input.txt> --source <lang> --target <lang> [options]
  lexweave render  <input.txt> --bundle <book.lexweave.json> [options]
  lexweave inspect <book.lexweave.json>

COMPILE OPTIONS
  --source <lang>        source language (e.g. zh)            [required]
  --target <lang>        target language (e.g. en)            [required]
  --title <title>        book title
  --provider <name>      anthropic | openai | mock            [default: openai]
  --model <model>        provider model override
  --extract-model <m>    model for the extraction pass only (defaults to --model;
                         lets translation run a stronger model while extraction
                         keeps its cheaper one — and its checkpoint cache)
  --glossary <file>      mock provider: glossary JSON ({entries:[{span,translation,...}]})
  --chunk-chars <n>      max characters per extraction call   [default: 8000]
                         smaller chunks = more calls = a larger unit pool
                         (models return ~25 units per call regardless of size)
  --concurrency <n>      parallel LLM calls (extraction + translation)
                         [default: 16, or 4096 with --batch-api] — raise if your
                         account tier allows, lower to 4-8 if the quality
                         report shows failed batches
  --batch-api            (openai only) run extraction + translation through the
                         OpenAI Batch API at 50% of synchronous token prices.
                         Results land within minutes to hours instead of live;
                         checkpoints and resume work exactly the same
  --full                 full-translation substrate: translate EVERY segment so
                         density 1.0 (all tiers unlocked) renders the whole book
                         in the target language. Costs O(book) tokens. Writes a
                         quality report next to the bundle (<out minus .json>.report.json).
  --fresh                discard the <out>.runs/ checkpoint cache and recompile
                         from scratch

  Compile checkpoints every extraction chunk and translation batch under
  <out>.runs/ as it finishes — an interrupted run resumes for free when
  re-run with the same inputs, glossary, provider, and model.
  -o, --out <file>       output bundle path                   [default: <input>.lexweave.json]

RENDER OPTIONS
  --bundle <file>        compiled bundle                      [required]
  --density <0..1>       replacement density                  [default: bundle strategy]
  --mastery <n>          preview mastery bonus (0=new reader; higher sheds scaffolding)
  --format <html|text>   output format                        [default: html]
  -o, --out <file>       output path                          [default: stdout]

EXAMPLES
  lexweave compile book.txt --source zh --target en -o book.lexweave.json
  lexweave compile book.txt --source zh --target en --provider mock --glossary glossary.json
  lexweave render book.txt --bundle book.lexweave.json --density 0.7 -o book.html

Keys: ANTHROPIC_API_KEY / OPENAI_API_KEY (env).
`

type Args = {positional: string[]; flags: Map<string, string | boolean>}

// Flags that never take a value, so `--full -o out.json` can't swallow `-o`.
const BOOLEAN_FLAGS = new Set(['full', 'fresh', 'batch-api'])

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-o') {
      flags.set('out', argv[++i] ?? '')
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (!BOOLEAN_FLAGS.has(name) && next != null && !next.startsWith('--')) {
        flags.set(name, next)
        i += 1
      } else {
        flags.set(name, true)
      }
    } else {
      positional.push(arg)
    }
  }
  return {positional, flags}
}

function str(args: Args, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function fail(message: string): never {
  console.error(`error: ${message}\n`)
  console.error(HELP)
  process.exit(1)
}

async function cmdCompile(args: Args): Promise<void> {
  const input = args.positional[0]
  if (!input) fail('compile requires an input text file')
  const source = str(args, 'source')
  const target = str(args, 'target')
  if (!source || !target) fail('compile requires --source and --target')

  const rawText = fs.readFileSync(input, 'utf8')
  const provider = str(args, 'provider') ?? 'openai'
  const model = str(args, 'model')
  // Resolve to the ACTUAL model names so fingerprint salts stay stable whether
  // the default is implicit or spelled out.
  const resolvedModel =
    model ??
    (provider === 'openai'
      ? OPENAI_DEFAULT_MODEL
      : provider === 'anthropic'
        ? ANTHROPIC_DEFAULT_MODEL
        : 'mock')
  const extractModel = str(args, 'extract-model') ?? resolvedModel

  const batchApi = args.flags.get('batch-api') === true
  if (batchApi && provider !== 'openai') {
    fail('--batch-api currently supports the openai provider only')
  }

  const llm =
    provider === 'mock'
      ? createMockLlm(loadGlossary(str(args, 'glossary')))
      : provider === 'openai'
        ? createOpenAiLlm({model, extractModel, batchApi})
        : createAnthropicLlm({model, extractModel})

  const chunkChars = Number(str(args, 'chunk-chars') ?? 8000)
  // Batch mode wants effectively-unbounded pipeline concurrency: every worker
  // just parks a request in the aggregator, and large aggregates are what make
  // one OpenAI batch submission carry hundreds of requests.
  const concurrency = Number(str(args, 'concurrency') ?? (batchApi ? 4096 : 16))
  const fullTranslation = args.flags.get('full') === true
  const title = str(args, 'title') ?? path.basename(input, path.extname(input))
  const outPath = str(args, 'out') ?? input.replace(/\.[^.]+$/, '') + '.lexweave.json'

  const runsDir = `${outPath}.runs`
  if (args.flags.get('fresh') === true) {
    fs.rmSync(runsDir, {recursive: true, force: true})
  }

  console.error(
    `compiling "${title}" (${rawText.length} chars, provider=${provider}` +
      `${fullTranslation ? ', full translation' : ''})...`
  )
  const result = await compileText(
    {rawText, title, sourceLanguage: source, targetLanguage: target},
    {
      llm,
      chunkChars,
      extractionConcurrency: concurrency,
      translationConcurrency: concurrency,
      fullTranslation,
      runStore: createFileRunStore(runsDir),
      // Per-pass salts on the RESOLVED models: switching only the translation
      // model re-keys the batches while the extraction chunk cache survives.
      runSalt: `${provider}:${resolvedModel}`,
      extractionSalt: `${provider}:${extractModel}`,
      producer: `lexweave-cli-${provider}@1`,
      onProgress(progress: CompileProgress) {
        console.error(
          `  chunk ${progress.chunkIndex + 1}/${progress.chunkCount} ` +
            `sections ${progress.sectionStart}-${progress.sectionEnd}: ` +
            `${progress.units} units, ${progress.usage.totalTokens} tokens, ${progress.elapsedMs}ms`
        )
      },
      onTranslateProgress(done, total) {
        if (done === 1 || done === total || done % 10 === 0) {
          console.error(`  translate ${done}/${total} batches`)
        }
      },
    }
  )

  // Pretty-printing roughly doubles a bundle's size; past ~20k units (a big
  // --full substrate) write compact so a 千万字 book stays writable and lean.
  const prettyBundle = result.bundle.candidates.length <= 20000
  fs.writeFileSync(outPath, JSON.stringify(result.bundle, null, prettyBundle ? 2 : undefined))

  let reportLine = ''
  if (result.translationReport) {
    const report = result.translationReport
    const reportPath = outPath.replace(/\.json$/, '') + '.report.json'
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    const counts = Object.entries(report.flagCounts)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(' ')
    reportLine =
      `  substrate: ${report.translated}/${report.totalSegments} segments translated` +
      `${result.translationCachedBatches ? `, ${result.translationCachedBatches} batches from cache` : ''}` +
      `${report.failedBatches ? `, ${report.failedBatches} batches FAILED` : ''}\n` +
      `  quality: ${counts || 'clean'} → ${reportPath}\n` +
      (result.translationContext
        ? `  book brief: ${result.translationContext.characters.length} characters, ` +
          `${result.translationContext.world.length} world notes\n`
        : '')
  }

  const {candidates, annotations} = result.bundle
  const byKind = countBy(candidates, (c) => c.kind)
  console.error(
    `\nwrote ${outPath}\n` +
      `  units: ${candidates.length} (${byKind.get('term') ?? 0} words, ` +
      `${byKind.get('phrase') ?? 0} phrases, ${byKind.get('sentence_pattern') ?? 0} sentences, ` +
      `${byKind.get('name') ?? 0} names) | concepts: ${annotations.length}\n` +
      `  dropped (span not verbatim): ${result.droppedUnlocatable}\n` +
      reportLine +
      `  base density: ${result.bundle.strategy.baseDensity} | tokens: ${result.usage.totalTokens}`
  )
  if (result.translationReport && result.translationReport.missing > 0) {
    console.error(
      `\nWARNING: ${result.translationReport.missing} segments are untranslated ` +
        `(${result.translationReport.failedBatches} failed batches). The bundle keeps them ` +
        `in the source language. Re-run the same command to resume from the checkpoint and fill them.`
    )
  }
}

async function cmdRender(args: Args): Promise<void> {
  const input = args.positional[0]
  if (!input) fail('render requires an input text file')
  const bundlePath = str(args, 'bundle')
  if (!bundlePath) fail('render requires --bundle')

  const rawText = fs.readFileSync(input, 'utf8')
  const bundle = parseBookBundle(fs.readFileSync(bundlePath, 'utf8'))
  const format = str(args, 'format') ?? 'html'
  const masteryBonus = Number(str(args, 'mastery') ?? 0)
  const density =
    str(args, 'density') != null ? Number(str(args, 'density')) : bundle.strategy.baseDensity

  const document = createDocumentFromPlainText({
    id: bundle.book.contentHash ?? 'book',
    rawText,
    title: bundle.book.title,
    kind: bundle.book.kind,
    sourceLanguage: bundle.book.sourceLanguage,
    defaultTargetLanguage: bundle.book.targetLanguage,
  })

  // Fresh reader: empty memory; `--mastery` previews how the page looks for a
  // reader further along (scaffolding sheds A1→A4 as the bonus grows).
  const {expressions} = expressionsFromAssets(bundle.candidates, bundle.annotations)
  const sessionState: ReadingSessionState = {
    userId: 'cli',
    contentId: document.id,
    targetLanguage: bundle.book.targetLanguage,
    readingProgress: 0,
    currentStage: 1,
    memory: createReadingMemory('cli', document.id),
  }
  const rules = planReplacements(expressions, sessionState, {
    budget: {density},
    masteryBonus,
  })
  const spatial = densityRenderOptions(density)
  const engine = createReplacementEngine({
    rules,
    coverage: spatial.coverage,
    minGap: spatial.minGap,
    renderMatch: format === 'text' ? plainMatchRenderer : undefined,
  })

  console.error(
    `rendering with ${rules.length} replacement rules ` +
      `(density ${density.toFixed(2)}, coverage ${spatial.coverage?.toFixed(2)}, ` +
      `minGap ${spatial.minGap}, mastery +${masteryBonus})`
  )

  const output = format === 'text' ? renderText(document, engine) : renderHtml(document, engine)
  const outPath = str(args, 'out')
  if (outPath) {
    fs.writeFileSync(outPath, output)
    console.error(`wrote ${outPath}`)
  } else {
    console.log(output)
  }
}

function renderText(document: ContentDocument, engine: ReplacementEngine): string {
  const parts: string[] = []
  for (const section of document.sections) {
    if (section.title) parts.push(`\n== ${section.title} ==\n`)
    const body = section.segments.map((segment) => segment.sourceText).join('\n\n')
    parts.push(engine.transformSection(body).output)
  }
  return parts.join('\n')
}

function renderHtml(document: ContentDocument, engine: ReplacementEngine): string {
  const sections = document.sections
    .map((section) => {
      const heading = section.title ? `<h2>${escapeHtml(section.title)}</h2>\n` : ''
      const body = section.segments
        .map((segment) => `<p>${escapeHtml(segment.sourceText)}</p>`)
        .join('\n')
      return heading + engine.transformSection(body).output
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="${escapeHtml(document.sourceLanguage)}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(document.title ?? 'Lexweave learning edition')}</title>
<style>
  body{max-width:42em;margin:2em auto;padding:0 1.2em;background:#faf7f0;color:#1b1b1b;
       font-family:Georgia,"Songti SC","Noto Serif SC",serif;line-height:2;font-size:1.05em}
  h1{font-size:1.5em} h2{margin-top:2.2em;font-size:1.2em}
  .ai-rep{color:#2e7d57;font-weight:600;cursor:pointer}
  .ai-rep[data-level="1"],.ai-rep[data-level="2"]{color:#5b7fae;font-weight:500}
  .ai-rep[data-level="4"]{color:inherit;font-weight:inherit}
  .ai-rep-open{color:#1b1b1b;font-weight:400;border-bottom:1px dotted #2e7d57}
  footer{margin:3em 0;color:#8a8378;font-size:.85em}
</style>
</head>
<body>
<h1>${escapeHtml(document.title ?? '')}</h1>
${sections}
<footer>Generated by Lexweave — tap a highlighted word to reveal the original.</footer>
<script>
document.addEventListener('click', (e) => {
  const el = e.target.closest('.ai-rep')
  if (!el) return
  if (el.dataset.shown === 'src') {
    el.textContent = el.dataset.rep
    el.dataset.shown = 'rep'
    el.classList.remove('ai-rep-open')
  } else {
    el.dataset.rep = el.textContent
    el.textContent = el.dataset.src
    el.dataset.shown = 'src'
    el.classList.add('ai-rep-open')
  }
})
</script>
</body>
</html>
`
}

function cmdInspect(args: Args): void {
  const bundlePath = args.positional[0]
  if (!bundlePath) fail('inspect requires a bundle file')
  const bundle: BookBundle = parseBookBundle(fs.readFileSync(bundlePath, 'utf8'))

  const byKind = countBy(bundle.candidates, (c) => c.kind)
  const bySalience = countBy(bundle.candidates, (c) => c.salience)
  const top = [...bundle.candidates]
    .filter((c) => c.salience === 'signature')
    .sort((a, b) => b.frequency * b.dispersion - a.frequency * a.dispersion)
    .slice(0, 15)

  const translationOf = new Map(
    bundle.annotations.map((a) => [a.canonicalSource, a.translations[0]?.targetText ?? '(keep)'])
  )

  console.log(`${bundle.book.title ?? '(untitled)'} — ${bundle.book.sourceLanguage} → ${bundle.book.targetLanguage}`)
  console.log(`producer: ${bundle.producer} | format: ${bundle.format} v${bundle.version}`)
  console.log(
    `book: ${bundle.book.sourceCharCount} chars, ${bundle.book.sectionCount} sections, ${bundle.book.segmentCount} segments`
  )
  console.log(
    `units: ${bundle.candidates.length} | concepts: ${bundle.annotations.length} | occurrences: ${bundle.occurrences.length}`
  )
  console.log(`by tier: ${fmtCounts(byKind)}`)
  console.log(`by salience: ${fmtCounts(bySalience)}`)
  console.log(
    `strategy: baseDensity=${bundle.strategy.baseDensity} promoteNotable=${bundle.strategy.promoteNotable}` +
      (bundle.strategy.note ? ` — ${bundle.strategy.note}` : '')
  )
  console.log('\ntop signature units (freq × dispersion):')
  for (const c of top) {
    console.log(
      `  ${c.sourceText}  →  ${translationOf.get(c.conceptCanonical) ?? '?'}  (freq ${c.frequency}, disp ${c.dispersion.toFixed(2)})`
    )
  }
}

function loadGlossary(file: string | undefined): MockGlossaryEntry[] {
  if (!file) {
    fail('the mock provider requires --glossary <file>')
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entries = Array.isArray(parsed) ? parsed : parsed.entries
  if (!Array.isArray(entries)) {
    fail('glossary must be an array or {entries: [...]} of {span, translation}')
  }
  return entries
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  }
  return counts
}

function fmtCounts(counts: Map<string, number>): string {
  return [...counts.entries()].map(([key, count]) => `${key}=${count}`).join(' ')
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (!command || command === 'help' || args.flags.has('help')) {
    console.log(HELP)
    return
  }
  if (command === 'compile') return cmdCompile(args)
  if (command === 'render') return cmdRender(args)
  if (command === 'inspect') return cmdInspect(args)
  fail(`unknown command "${command}"`)
}

main().catch((error) => {
  console.error(`error: ${error?.message ?? error}`)
  process.exit(1)
})
