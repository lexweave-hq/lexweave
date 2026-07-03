// Generate a self-contained interactive debug page for a compiled book:
// live sliders for density / mastery preview / simulated-mastered words, with
// the REAL @lexweave/core planner + @lexweave/render engine bundled inline —
// zero drift from what the CLI and the app WebView execute.
//
// Usage: node scripts/debug-render.mjs <input.txt> --bundle <book.lexweave.json> -o <out.html>
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'

const require = createRequire(import.meta.url)
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const esbuild = require(path.join(repo, 'node_modules', 'esbuild'))
const core = require(path.join(repo, 'packages', 'core', 'dist'))

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const positional = []
const flags = new Map()
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-o' || argv[i] === '--out') flags.set('out', argv[++i])
  else if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i])
  else positional.push(argv[i])
}
const input = positional[0]
const bundlePath = flags.get('bundle')
if (!input || !bundlePath) {
  console.error('usage: node scripts/debug-render.mjs <input.txt> --bundle <book.lexweave.json> -o <out.html>')
  process.exit(1)
}
const outPath = flags.get('out') ?? input.replace(/\.txt$/, '') + '-debug.html'

// ── data prep (same path as the CLI render command) ───────────────────────────
const rawText = fs.readFileSync(input, 'utf8')
const bundle = core.parseBookBundle(fs.readFileSync(bundlePath, 'utf8'))
const {expressions} = core.expressionsFromAssets(bundle.candidates, bundle.annotations)

// Paginate on paragraph boundaries (~6000 chars/page) so the browser re-renders
// one page per knob change instead of the whole book.
const PAGE_CHARS = 6000
const paragraphs = rawText.split(/\n+/).filter((p) => p.trim())
const pages = []
let current = []
let currentLen = 0
for (const p of paragraphs) {
  if (currentLen > 0 && currentLen + p.length > PAGE_CHARS) {
    pages.push(current.join('\n'))
    current = []
    currentLen = 0
  }
  current.push(p)
  currentLen += p.length
}
if (current.length) pages.push(current.join('\n'))

// ── browser runtime: the real planner + engine, tree-shaken (no zod) ──────────
const runtime = await esbuild.build({
  stdin: {
    contents: [
      `export {planReplacements} from './packages/core/src/replacement-planner'`,
      `export {MASTERY_RETIRE} from './packages/core/src/flow-budget'`,
      `export {createReplacementEngine, densityRenderOptions, levelDisplay} from './packages/render/src/index'`,
    ].join('\n'),
    resolveDir: repo,
    loader: 'ts',
  },
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'Lexweave',
  target: ['es2019'],
  write: false,
})
const runtimeJs = runtime.outputFiles[0].text

// ── node-side smoke test of the same logic the page will run ─────────────────
{
  const session = {
    userId: 'debug', contentId: 'debug', targetLanguage: bundle.book.targetLanguage,
    readingProgress: 0, currentStage: 1, memory: core.createReadingMemory('debug', 'debug'),
  }
  const rules = core.planReplacements(expressions, session, {budget: {density: bundle.strategy.baseDensity}})
  console.error(`smoke: ${rules.length} rules at base density ${bundle.strategy.baseDensity.toFixed(2)}, ${pages.length} pages`)
}

const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c')

const meta = {
  title: bundle.book.title ?? path.basename(input),
  targetLanguage: bundle.book.targetLanguage,
  baseDensity: Math.round(bundle.strategy.baseDensity * 100) / 100,
}

// ── page template ─────────────────────────────────────────────────────────────
const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${meta.title} · lexweave debug</title>
<style>
  :root { --accent:#2e7d57; --gloss:#5b7fae; --bg:#faf9f7; --fg:#26241f; --bar:#ffffff; --line:#e4e0d8; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:system-ui,-apple-system,sans-serif }
  #bar { position:sticky; top:0; z-index:10; background:var(--bar); border-bottom:1px solid var(--line);
         padding:10px 16px; display:flex; flex-wrap:wrap; gap:14px 22px; align-items:center; font-size:13px }
  #bar .knob { display:flex; align-items:center; gap:8px; white-space:nowrap }
  #bar label { color:#6b675e }
  #bar input[type=range] { width:130px; accent-color:var(--accent) }
  #bar .val { font-variant-numeric:tabular-nums; min-width:5.5em; color:var(--fg) }
  #bar button { border:1px solid var(--line); background:#fff; border-radius:6px; padding:3px 10px; cursor:pointer; font-size:13px }
  #bar button:hover { border-color:var(--accent) }
  #stats { font-size:12px; color:#6b675e; padding:6px 16px; border-bottom:1px solid var(--line);
           background:var(--bar); font-variant-numeric:tabular-nums }
  #stats b { color:var(--fg) }
  #content { max-width:42em; margin:0 auto; padding:28px 20px 80px;
             font-family:"Songti SC","Noto Serif CJK SC",Georgia,serif; font-size:17px; line-height:1.95 }
  #content p { margin:0 0 1em }
  .ai-rep { color:var(--accent); font-weight:600; cursor:pointer }
  .ai-rep[data-level="1"], .ai-rep[data-level="2"] { color:var(--gloss); font-weight:500 }
  .ai-rep[data-level="4"] { color:inherit; font-weight:inherit }
  body.hl .ai-rep { background:rgba(46,125,87,.09); border-radius:3px; padding:0 2px }
  body.hl .ai-rep[data-level="1"], body.hl .ai-rep[data-level="2"] { background:rgba(91,127,174,.10) }
  body.hl .ai-rep[data-level="4"] { background:rgba(160,140,60,.13) }
  .ai-rep-open { color:var(--fg) !important; font-weight:400 !important; border-bottom:1px dotted var(--accent) }
  details#rules { max-width:42em; margin:10px auto 0; padding:0 20px; font-size:13px; color:#6b675e }
  details#rules table { border-collapse:collapse; margin-top:6px; width:100% }
  details#rules td { padding:2px 10px 2px 0; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums }
  .badge { display:inline-block; font-size:11px; padding:0 6px; border-radius:8px; background:#efe9dc; color:#7a6a3a }
</style>
</head>
<body class="hl">
<div id="bar">
  <div class="knob"><label>密度</label><input id="density" type="range" min="0" max="1" step="0.01"><span class="val" id="densityVal"></span></div>
  <div class="knob"><label>熟练度预览</label><input id="mastery" type="range" min="0" max="6" step="1"><span class="val" id="masteryVal"></span></div>
  <div class="knob"><label>模拟已掌握</label><input id="mastered" type="range" min="0" step="1"><span class="val" id="masteredVal"></span></div>
  <div class="knob"><label><input id="hl" type="checkbox" checked> 高亮替换</label></div>
  <div class="knob">
    <button id="prev">←</button>
    <span class="val" id="pageVal"></span>
    <button id="next">→</button>
    <button id="hitPrev" title="上一处有替换的页">◀ 替换</button>
    <button id="hitNext" title="下一处有替换的页">替换 ▶</button>
  </div>
</div>
<div id="stats"></div>
<details id="rules"><summary>活动规则</summary><div id="rulesBody"></div></details>
<div id="content"></div>

<script id="lx-data" type="application/json">${json({meta, pages, expressions})}</script>
<script>${runtimeJs}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('lx-data').textContent)
  const {meta, pages, expressions} = data
  const $ = (id) => document.getElementById(id)

  // Same priority the planner uses, for choosing which words to simulate as mastered.
  const BOOST = {signature: 1000, notable: 100}
  const learnable = expressions
    .filter((e) => !e.shouldKeepSource && e.salience !== 'name' && e.salience !== 'none')
    .sort((a, b) => ((BOOST[b.salience] || 0) + b.frequency * b.dispersion) -
                    ((BOOST[a.salience] || 0) + a.frequency * a.dispersion))
  const learnableIds = [...new Set(learnable.map((e) => e.id))]

  // Shareable state: ?density=0.5&mastery=2&mastered=20&page=37&hl=0
  const params = new URLSearchParams(location.search)
  const num = (k, fallback) => (params.has(k) && !isNaN(+params.get(k)) ? +params.get(k) : fallback)
  const state = {
    density: num('density', meta.baseDensity),
    mastery: num('mastery', 0),
    mastered: num('mastered', 0),
    page: Math.min(pages.length - 1, Math.max(0, num('page', 1) - 1)),
  }
  $('density').value = state.density
  $('mastery').value = state.mastery
  $('mastered').max = Math.min(learnableIds.length, 80)
  $('mastered').value = state.mastered
  if (params.get('hl') === '0') { document.body.classList.remove('hl'); $('hl').checked = false }
  let lastRules = []

  const escapeHtml = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

  const render = () => {
    const memoryStats = {}
    for (const id of learnableIds.slice(0, state.mastered)) {
      memoryStats[id] = {seenCount: 12, replacedCount: 0, explainCount: 0, frictionScore: 0, masteryScore: 3}
    }
    const session = {
      userId: 'debug', contentId: 'debug', targetLanguage: meta.targetLanguage,
      readingProgress: 0, currentStage: 1,
      memory: {userId: 'debug', contentId: 'debug', expressionStats: memoryStats},
    }
    const rules = Lexweave.planReplacements(expressions, session, {
      budget: {density: state.density},
      masteryBonus: state.mastery,
    })
    lastRules = rules
    const spatial = Lexweave.densityRenderOptions(state.density)
    const engine = Lexweave.createReplacementEngine({rules, coverage: spatial.coverage, minGap: spatial.minGap})
    const pageHtml = pages[state.page].split(/\\n+/).map((p) => '<p>' + escapeHtml(p) + '</p>').join('')
    const t0 = performance.now()
    const {output} = engine.transformSection(pageHtml)
    const ms = performance.now() - t0
    $('content').innerHTML = output

    const spans = output.split('class="ai-rep"').length - 1
    const levels = {}
    for (const m of output.matchAll(/data-level="(\\d)"/g)) levels[m[1]] = (levels[m[1]] || 0) + 1
    const retired = rules.filter((r) => r.retired).length
    $('densityVal').textContent = state.density.toFixed(2) + ' (cov ' + spatial.coverage.toFixed(2) + ' gap ' + spatial.minGap + ')'
    $('masteryVal').textContent = '+' + state.mastery
    $('masteredVal').textContent = state.mastered + ' 词'
    $('pageVal').textContent = (state.page + 1) + ' / ' + pages.length
    const tierCount = (t) => rules.filter((r) => !r.retired && r.tier === t).length
    $('stats').innerHTML = '规则 <b>' + rules.length + '</b>（词 ' + tierCount('word') +
      ' · 短语 ' + tierCount('phrase') + ' · 句 ' + tierCount('sentence') +
      ' · 已掌握 ' + retired + '）｜本页替换 <b>' + spans + '</b> 处｜层级 ' +
      Object.entries(levels).map(([l, n]) => 'A' + l + '×' + n).join(' ') +
      '｜渲染 ' + ms.toFixed(1) + 'ms' +
      (spans === 0 ? '｜<b>本页无匹配</b>——点「替换 ▶」跳到有替换的页' : '')

    const tierName = {word: '词', phrase: '短语', sentence: '句'}
    $('rulesBody').innerHTML = '<table>' + rules.slice(0, 60).map((r) =>
      '<tr><td>' + (tierName[r.tier] || '') + '</td><td>' + escapeHtml(r.from) + '</td><td>' +
      escapeHtml(String(r.to)) + '</td><td>A' + r.level +
      (r.retired ? ' <span class="badge">已掌握</span>' : '') + '</td></tr>').join('') +
      '</table>' + (rules.length > 60 ? '<p>… 共 ' + rules.length + ' 条</p>' : '')
    return spans
  }

  let raf = 0
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render) }

  $('density').addEventListener('input', (e) => { state.density = +e.target.value; schedule() })
  $('mastery').addEventListener('input', (e) => { state.mastery = +e.target.value; schedule() })
  $('mastered').addEventListener('input', (e) => { state.mastered = +e.target.value; schedule() })
  $('hl').addEventListener('change', (e) => document.body.classList.toggle('hl', e.target.checked))
  const go = (d) => { state.page = Math.min(pages.length - 1, Math.max(0, state.page + d)); schedule(); scrollTo(0, 0) }
  $('prev').addEventListener('click', () => go(-1))
  $('next').addEventListener('click', () => go(1))
  // Jump to the nearest page that the CURRENT rule set actually touches — front
  // matter and sparse chapters otherwise make the sliders look inert.
  const hitJump = (dir) => {
    for (let i = state.page + dir; i >= 0 && i < pages.length; i += dir) {
      if (lastRules.some((r) => pages[i].includes(r.from))) {
        state.page = i
        render()
        scrollTo(0, 0)
        return
      }
    }
  }
  $('hitPrev').addEventListener('click', () => hitJump(-1))
  $('hitNext').addEventListener('click', () => hitJump(1))
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(-1)
    if (e.key === 'ArrowRight') go(1)
  })

  // Tap-to-reveal, same behavior as the app runtime.
  $('content').addEventListener('click', (e) => {
    const el = e.target.closest('.ai-rep')
    if (!el) return
    if (el.getAttribute('data-shown') === 'src') {
      el.textContent = el.getAttribute('data-rep')
      el.setAttribute('data-shown', 'rep')
      el.classList.remove('ai-rep-open')
    } else {
      el.setAttribute('data-rep', el.textContent)
      el.textContent = el.getAttribute('data-src') || el.textContent
      el.setAttribute('data-shown', 'src')
      el.classList.add('ai-rep-open')
    }
  })

  // Land on content, not front matter: if the opening page has no matches (and
  // the user didn't pin one via ?page=), jump forward to the first page that does.
  if (render() === 0 && !params.has('page')) hitJump(1)
})()
</script>
</body>
</html>`

fs.writeFileSync(outPath, html)
console.error(`wrote ${outPath} (${(html.length / 1024 / 1024).toFixed(1)} MB, ${pages.length} pages, ${expressions.length} units)`)
