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
let rawText = fs.readFileSync(input, 'utf8')
const bundle = core.parseBookBundle(fs.readFileSync(bundlePath, 'utf8'))

// --slice-chars <n>: debug a slice of a huge book. A full-substrate bundle
// embeds every unit into the page; for a 百万字 book that is a >100MB HTML no
// browser will open. Cutting the text (at a paragraph boundary) and keeping
// only the units whose spans occur in the slice keeps the page interactive
// while still exercising the exact planner + engine the app runs.
const sliceChars = Number(flags.get('slice-chars') ?? 0)
if (sliceChars > 0 && rawText.length > sliceChars) {
  const cut = rawText.lastIndexOf('\n', sliceChars)
  rawText = rawText.slice(0, cut > 0 ? cut : sliceChars)
  const before = bundle.candidates.length
  bundle.candidates = bundle.candidates.filter((c) => rawText.includes(c.sourceText))
  const keptConcepts = new Set(bundle.candidates.map((c) => c.conceptCanonical))
  bundle.annotations = bundle.annotations.filter((a) => keptConcepts.has(a.canonicalSource))
  console.error(
    `slice: ${rawText.length} chars, units ${before} → ${bundle.candidates.length}, ` +
      `concepts → ${bundle.annotations.length}`
  )
}

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
      `export {MASTERY_RETIRE, tierQuotas} from './packages/core/src/flow-budget'`,
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
  :root { --accent:#2e7d57; --gloss:#5b7fae; --bg:#faf9f7; --fg:#26241f; --bar:#ffffff; --line:#e4e0d8; --dim:#6b675e }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:system-ui,-apple-system,sans-serif;
         display:flex; align-items:flex-start }

  /* ── sidebar ── */
  #side { width:320px; flex:none; position:sticky; top:0; height:100vh; overflow-y:auto;
          background:var(--bar); border-right:1px solid var(--line); padding:16px 18px 40px; font-size:13px }
  #side h1 { font-size:15px; margin:0 0 2px }
  #side .meta { color:var(--dim); font-size:12px; margin-bottom:14px }
  #side h2 { font-size:12px; color:var(--dim); letter-spacing:.08em;
             border-bottom:1px solid var(--line); padding-bottom:4px; margin:18px 0 10px }
  #side .knob { display:flex; align-items:center; gap:8px; white-space:nowrap; margin:8px 0 2px }
  #side .knob label { color:var(--fg); min-width:4em }
  #side input[type=range] { flex:1; min-width:0; accent-color:var(--accent) }
  #side .val { font-variant-numeric:tabular-nums; color:var(--dim); font-size:12px; min-width:3.5em; text-align:right }
  #side select { border:1px solid var(--line); background:#fff; border-radius:6px; padding:3px 6px; font-size:12px; flex:1; min-width:0 }
  #side .help { margin:2px 0 10px; color:var(--dim); font-size:12px; line-height:1.65 }
  #side .help b { color:var(--fg); font-weight:600 }
  #side .tiers { display:flex; gap:14px; margin:6px 0 2px }
  #side .tiers label { white-space:nowrap }
  #legend .lg { margin:0 0 12px }
  #legend .lg .tag { display:inline-block; font-size:11px; color:var(--dim); min-width:2em }
  #legend .lg p { margin:3px 0 0; color:var(--dim); font-size:12px; line-height:1.6 }
  #legend .sample { font-family:"Songti SC","Noto Serif CJK SC",Georgia,serif; font-size:14px }
  details#rules { margin-top:18px; font-size:12px; color:var(--dim) }
  details#rules summary { cursor:pointer; color:var(--fg) }
  details#rules table { border-collapse:collapse; margin-top:6px; width:100%; table-layout:fixed }
  details#rules th { text-align:left; font-weight:500; color:var(--dim); padding:2px 6px 4px 0;
                     border-bottom:1px solid var(--line) }
  details#rules td { padding:3px 6px 3px 0; border-bottom:1px solid var(--line);
                     font-variant-numeric:tabular-nums; vertical-align:top }
  details#rules td.src, details#rules td.tgt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  details#rules .star { color:#b8860b }
  .lv { display:inline-block; font-size:11px; padding:0 5px; border-radius:8px; white-space:nowrap }
  .lv1 { background:rgba(91,127,174,.20) }
  .lv2 { background:rgba(70,150,166,.18) }
  .lv3 { background:rgba(46,125,87,.18) }
  .lv4 { background:rgba(196,160,60,.22) }

  /* ── main column ── */
  #main { flex:1; min-width:0 }
  #topbar { position:sticky; top:0; z-index:10; background:var(--bar); border-bottom:1px solid var(--line);
            padding:8px 16px; display:flex; gap:18px; align-items:center; font-size:13px }
  #topbar button { border:1px solid var(--line); background:#fff; border-radius:6px; padding:3px 12px; cursor:pointer; font-size:13px }
  #topbar button:hover { border-color:var(--accent) }
  #topbar .pager { display:flex; align-items:center; gap:8px; white-space:nowrap }
  #topbar .val { font-variant-numeric:tabular-nums }
  #stats { font-size:12px; color:var(--dim); font-variant-numeric:tabular-nums; min-width:0 }
  #stats b { color:var(--fg) }
  #stats a { color:var(--accent) }
  #content { max-width:42em; margin:0 auto; padding:28px 20px 80px;
             font-family:"Songti SC","Noto Serif CJK SC",Georgia,serif; font-size:17px; line-height:1.95 }
  #content.sans, #content.sans p { font-family:system-ui,-apple-system,"PingFang SC",sans-serif }
  #content p { margin:0 0 1em }

  /* ── replacement spans ──────────────────────────────────────────────────────
     Structured markup from the page's custom renderMatch:
       A1  <span .ai-rep><span .pri>原文</span><span .gl>译文</span></span>
       A2  <span .ai-rep><span .pri>译文</span><span .gl>原文</span></span>
       A3+ <span .ai-rep>译文</span>
     The scaffold ladder must be VISIBLE: prominence strictly decreases
     A1 → A2 → A3 → A4 (plain page text, full immersion). */
  .ai-rep { cursor:pointer }

  /* gloss (注释) style: brackets are CSS, not text — switchable */
  body.gl-paren .gl::before { content:"（" }
  body.gl-paren .gl::after { content:"）" }
  body.gl-inline .gl { margin-left:.35em }
  body.gl-ruby .gl { font-size:.68em; vertical-align:super; margin-left:2px }

  /* 阅读态: graded prominence (default, the product semantics) */
  body.m-read .ai-rep[data-level="0"], body.m-read .ai-rep[data-level="1"] {
    background:rgba(91,127,174,.12); border-radius:3px; padding:0 2px }
  body.m-read .ai-rep[data-level="0"] .gl, body.m-read .ai-rep[data-level="1"] .gl { color:var(--gloss) }
  body.m-read .ai-rep[data-level="2"] .pri { color:var(--gloss); font-weight:500 }
  body.m-read .ai-rep[data-level="2"] .gl { color:#9a958a; font-size:.9em }
  body.m-read .ai-rep[data-level="3"] { color:var(--accent); font-weight:600;
    border-bottom:1px dotted rgba(46,125,87,.55) }
  /* A4: intentionally NOTHING — a mastered word is plain page text */

  /* 调试着色: every level gets an unmistakable tint */
  body.m-debug .ai-rep { border-radius:3px; padding:0 2px }
  body.m-debug .ai-rep[data-level="0"], body.m-debug .ai-rep[data-level="1"] { background:rgba(91,127,174,.20) }
  body.m-debug .ai-rep[data-level="2"] { background:rgba(70,150,166,.18) }
  body.m-debug .ai-rep[data-level="3"] { background:rgba(46,125,87,.18) }
  body.m-debug .ai-rep[data-level="4"] { background:rgba(196,160,60,.22) }
  body.m-debug .ai-rep .gl { color:var(--gloss) }
  body.m-debug .ai-rep[data-level="2"] .gl { color:#8a8577 }

  /* 无标记: pure text — no rule needed */

  /* A3/A4 注原文 (debug aid): pull the source out of data-src */
  body.anno .ai-rep[data-level="3"]::after, body.anno .ai-rep[data-level="4"]::after {
    content:"（" attr(data-src) "）"; color:#8a8577; font-weight:400; font-size:.88em }

  .ai-rep-open { color:var(--fg) !important; font-weight:400 !important; background:none !important;
    border-bottom:1px dotted var(--accent) }
  .ai-rep-open::after { content:none !important }

  @media (max-width:880px) {
    body { display:block }
    #side { position:static; width:auto; height:auto; border-right:none; border-bottom:1px solid var(--line) }
  }
</style>
</head>
<body class="m-read gl-paren">
<aside id="side">
  <h1>${meta.title}</h1>
  <div class="meta">目标语言 ${meta.targetLanguage} ｜ 基础密度 ${meta.baseDensity} ｜ <span id="metaCounts"></span></div>

  <h2>参数</h2>
  <div class="knob"><label>密度</label><input id="density" type="range" min="0" max="1" step="0.01"><span class="val" id="densityVal"></span></div>
  <p class="help">密度在两处生效。<b>①选词（planner）</b>：决定同时在学的<b>不同词位数</b>——词取 max(8, 密度×可学词数)；短语/句取 密度×min(已解锁槽位, 可用数)。选中的词位全书<b>每次出现都替换</b>（不设次数上限，重复即学习）；学习中被点开 ≥4 次的词判为高摩擦，暂停替换。<b>②排版（renderer）</b>：派生覆盖率上限 cov = 0.15 + 0.8×密度（封顶 0.95；密度=1 放开到全页）与相邻替换的最小间隔 gap = (1−密度)×24 个可见字符。宽度按读者所见计：汉字≈2、拉丁≈1，以<b>显示文本</b>（含注释）计宽。已掌握（A4）词不占任何预算。</p>
  <div class="knob"><label>熟练度预览</label><input id="mastery" type="range" min="0" max="6" step="1"><span class="val" id="masteryVal"></span></div>
  <p class="help">给所有词位临时 +N 级熟练度，预览读者水平提升后的页面。对宏观阶梯按层<b>错开</b>生效（词 +N、短语 +N−1、句 +N−2），模拟自下而上的真实积累，避免句层从 0 一步跳到刷屏。只影响显示，不写入记忆。</p>
  <div class="knob"><label>模拟已掌握</label><input id="mastered" type="range" min="0" step="1"><span class="val" id="masteredVal"></span></div>
  <p class="help">按学习优先级（签名词 &gt; 高频且分布均匀）把前 N 个可学词的记忆直接设到退休线（熟练度 3）：以 A4 纯译文出现、不占预算，并为短语/句<b>挣得槽位</b>（见宏观阶梯）。</p>

  <h2>宏观阶梯：词 → 短语 → 句</h2>
  <p class="help">微观阶梯（A1→A4）管一个词位<b>多裸</b>，宏观阶梯管替换单元<b>多大</b>。爬坡是连续的，没有解锁开关：<br>
  <b>配额（能上多少）</b>——每个词位贡献掌握质量 mass = min(1, 熟练度/3)；1 点词质量挣 <b>2</b> 个短语槽，1 点短语质量挣 <b>3</b> 个句槽，同层另有 ×2 自增项，让级联能一路推到整页译文。<br>
  <b>就绪度（谁先上）</b>——短语/句按其文本被「已读作译文的表面」（已掌握或 A3+ 的词位）覆盖的比例排序，覆盖高者先翻转（i+1 可理解输入）。所以翻转出现在掌握词聚集处，而不是按章节顺序推进。</p>
  <div class="tiers">
    <label><input id="tw" type="checkbox" checked> 词</label>
    <label><input id="tp" type="checkbox" checked> 短语</label>
    <label><input id="ts" type="checkbox" checked> 句</label>
  </div>
  <p class="help">仅预览用：取消勾选把该层已入选的规则从渲染中滤掉，不改变 planner 的选词。</p>

  <h2>显示</h2>
  <div class="knob"><label>标记样式</label>
    <select id="hlStyle">
      <option value="read">阅读态（层级递减）</option>
      <option value="debug">调试（每级着色）</option>
      <option value="none">无标记</option>
    </select>
  </div>
  <p class="help">阅读态即产品语义：A1 蓝底最醒目 → A2 去底色 → A3 只剩绿色+虚线 → A4 与正文零差别。调试模式给四级各上底色（A1 蓝 / A2 青 / A3 绿 / A4 金），专查层级分布。</p>
  <div class="knob"><label>注释样式</label>
    <select id="glossStyle">
      <option value="paren">括号：灵石（spirit stone）</option>
      <option value="inline">并列：灵石 spirit stone</option>
      <option value="ruby">上标小注</option>
    </select>
  </div>
  <p class="help">括号不再是文本的一部分，而是样式——A1/A2 的注释可切括号 / 空格并列 / 上标小注。</p>
  <div class="knob"><label>呈现形态</label>
    <select id="forceLevel">
      <option value="">跟随熟练度</option>
      <option value="1">全部 A1</option>
      <option value="2">全部 A2</option>
      <option value="3">全部 A3</option>
    </select>
  </div>
  <p class="help">强制所有未掌握词位按同一等级显示，单独查看某一级效果；已掌握（A4）不受影响。</p>
  <div class="knob"><label><input id="anno" type="checkbox"> A3/A4 注原文</label></div>
  <p class="help">调试辅助：给 A3/A4 的纯译文补灰色（原文）。默认参数下全书多为 A1（自带注释），需配合熟练度预览或「全部 A3」才看得到效果。</p>
  <div class="knob"><label>字号</label><input id="font" type="range" min="14" max="24" step="1"><span class="val" id="fontVal"></span></div>
  <div class="knob"><label>行距</label><input id="lh" type="range" min="1.5" max="2.6" step="0.05"><span class="val" id="lhVal"></span></div>
  <div class="knob"><label>字体</label>
    <select id="fontFamily">
      <option value="serif">衬线（宋体）</option>
      <option value="sans">无衬线（黑体）</option>
    </select>
  </div>

  <h2>等级图例（活的，随上面选项变）</h2>
  <div id="legend">
    <div class="lg"><span class="tag">A1</span> <span class="sample"><span class="ai-rep" data-level="1" data-src="灵石"><span class="pri">灵石</span><span class="gl">spirit stone</span></span></span>
      <p>新词起点：原文为主 + 译文注，蓝底最醒目。剧情关键（plot high）或高翻译风险的词被<b>锁</b>在 A1，该词每 1 点熟练度赎回 1 级上限。</p></div>
    <div class="lg"><span class="tag">A2</span> <span class="sample"><span class="ai-rep" data-level="2" data-src="灵石"><span class="pri">spirit stone</span><span class="gl">灵石</span></span></span>
      <p>该词曝光（看到 + 被替换）≥3 次：翻转为译文为主，原文退成灰色小注，底色撤掉——存在感降一档。</p></div>
    <div class="lg"><span class="tag">A3</span> <span class="sample"><span class="ai-rep" data-level="3" data-src="灵石">spirit stone</span></span>
      <p>该词熟练度 ≥1：注释消失只剩译文，绿色 + 虚线下划线是「可点按看原文」的最后提示。</p></div>
    <div class="lg"><span class="tag">A4</span> <span class="sample"><span class="ai-rep" data-level="4" data-src="灵石">spirit stone</span></span>
      <p>熟练度 ≥2 进 A4、≥3 正式退休：<b>与正文零差别</b>，完全沉浸；不占密度/间距预算，点按＝回忆自测，永不回退原文。</p></div>
    <p class="help">A0＝未浮现（被资格筛选或密度挡下）；A5＝保留的整句扫掠层。</p>
  </div>

  <details id="rules"><summary>当前替换规则 <span id="rulesCount"></span></summary>
    <p class="help">planner 为当前参数<b>实际选出</b>的词位，按学习优先级排序（<span class="star">★</span>＝签名词，优先入选）。「级」是该词位此刻的真实脚手架等级，色块与调试着色一致——新读者（熟练度 0、无掌握词）<b>所有词都从 A1 起步</b>，这不是 bug；拖「熟练度预览」或「模拟已掌握」就能看到等级爬升、短语/句入场。「呈现形态」只改渲染，不改这里的真实等级。</p>
    <div id="rulesBody"></div>
  </details>
</aside>

<div id="main">
  <div id="topbar">
    <div class="pager" title="快捷键 ← →">
      <button id="prev">←</button>
      <span class="val" id="pageVal"></span>
      <button id="next">→</button>
    </div>
    <div id="stats"></div>
  </div>
  <div id="content"></div>
</div>

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
  const exprBySource = new Map()
  for (const e of expressions) if (!exprBySource.has(e.sourceText)) exprBySource.set(e.sourceText, e)
  $('metaCounts').textContent = pages.length + ' 页 · ' + expressions.length + ' 词单元'

  // Shareable state:
  // ?density=0.5&mastery=2&mastered=20&page=37&style=debug&gloss=inline&force=3&anno=1&w=0&p=0&s=0&font=18&lh=2.2&ff=sans
  const params = new URLSearchParams(location.search)
  const num = (k, fallback) => (params.has(k) && !isNaN(+params.get(k)) ? +params.get(k) : fallback)
  const styleParam = params.get('style')
  const state = {
    density: num('density', meta.baseDensity),
    mastery: num('mastery', 0),
    mastered: num('mastered', 0),
    page: Math.min(pages.length - 1, Math.max(0, num('page', 1) - 1)),
    style: ['read', 'debug', 'none'].includes(styleParam) ? styleParam
      : styleParam === 'bg' || styleParam === 'ul' ? 'debug' // 旧链接
      : params.get('hl') === '0' ? 'none' : 'read',
    gloss: ['paren', 'inline', 'ruby'].includes(params.get('gloss')) ? params.get('gloss') : 'paren',
    forceLevel: ['1', '2', '3'].includes(params.get('force')) ? params.get('force') : '',
    anno: params.get('anno') === '1',
    tiers: {word: params.get('w') !== '0', phrase: params.get('p') !== '0', sentence: params.get('s') !== '0'},
    font: Math.min(24, Math.max(14, num('font', 17))),
    lh: Math.min(2.6, Math.max(1.5, num('lh', 1.95))),
    fontFamily: params.get('ff') === 'sans' ? 'sans' : 'serif',
  }
  $('density').value = state.density
  $('mastery').value = state.mastery
  $('mastered').max = Math.min(learnableIds.length, 80)
  $('mastered').value = state.mastered
  $('hlStyle').value = state.style
  $('glossStyle').value = state.gloss
  $('forceLevel').value = state.forceLevel
  $('anno').checked = state.anno
  $('tw').checked = state.tiers.word
  $('tp').checked = state.tiers.phrase
  $('ts').checked = state.tiers.sentence
  $('font').value = state.font
  $('lh').value = state.lh
  $('fontFamily').value = state.fontFamily
  const applyLook = () => {
    document.body.className = 'm-' + state.style + ' gl-' + state.gloss + (state.anno ? ' anno' : '')
    $('content').classList.toggle('sans', state.fontFamily === 'sans')
    $('content').style.fontSize = state.font + 'px'
    $('content').style.lineHeight = state.lh
    $('fontVal').textContent = state.font + 'px'
    $('lhVal').textContent = state.lh.toFixed(2)
  }
  applyLook()
  let lastRules = []

  const escapeHtml = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const escapeAttr = (s) => escapeHtml(s).replace(/"/g,'&quot;')

  // Structured renderer: source/target in separate nodes so brackets & emphasis
  // are pure CSS. Per level the visible first/last characters match the engine's
  // default display string, so pangu spacing and coverage billing stay faithful.
  const renderMatch = (m) => {
    const lv = typeof m.level === 'number' ? m.level : 3
    const open = '<span class="ai-rep" data-level="' + lv + '" data-src="' + escapeAttr(m.from) + '"' +
      (m.retired ? ' data-retired="1"' : '') + '>'
    if (lv <= 1) return open + '<span class="pri">' + escapeHtml(m.from) + '</span><span class="gl">' + escapeHtml(m.to) + '</span></span>'
    if (lv === 2) return open + '<span class="pri">' + escapeHtml(m.to) + '</span><span class="gl">' + escapeHtml(m.from) + '</span></span>'
    return open + escapeHtml(m.to) + '</span>'
  }

  const render = () => {
    const memoryStats = {}
    for (const id of learnableIds.slice(0, state.mastered)) {
      memoryStats[id] = {seenCount: 12, replacedCount: 0, explainCount: 0, frictionScore: 0, masteryScore: 3}
    }
    const memory = {userId: 'debug', contentId: 'debug', expressionStats: memoryStats}
    const session = {
      userId: 'debug', contentId: 'debug', targetLanguage: meta.targetLanguage,
      readingProgress: 0, currentStage: 1, memory,
    }
    const rules = Lexweave.planReplacements(expressions, session, {
      budget: {density: state.density},
      masteryBonus: state.mastery,
    })
    lastRules = rules
    const quotas = Lexweave.tierQuotas(expressions, memory, state.mastery)
    // Display-only transforms: tier filter + 呈现形态 override (retired keep A4).
    let shown = rules.filter((r) => state.tiers[r.tier || 'word'])
    if (state.forceLevel) {
      shown = shown.map((r) => (r.retired ? r : Object.assign({}, r, {level: +state.forceLevel})))
    }
    const spatial = Lexweave.densityRenderOptions(state.density)
    const engine = Lexweave.createReplacementEngine({
      rules: shown, coverage: spatial.coverage, minGap: spatial.minGap, renderMatch,
    })
    const pageHtml = pages[state.page].split(/\\n+/).map((p) => '<p>' + escapeHtml(p) + '</p>').join('')
    const t0 = performance.now()
    const {output} = engine.transformSection(pageHtml)
    const ms = performance.now() - t0
    $('content').innerHTML = output

    const spans = output.split('class="ai-rep"').length - 1
    const levels = {}
    for (const m of output.matchAll(/data-level="(\\d)"/g)) levels[m[1]] = (levels[m[1]] || 0) + 1
    const retired = rules.filter((r) => r.retired).length
    $('densityVal').textContent = state.density.toFixed(2)
    $('masteryVal').textContent = '+' + state.mastery
    $('masteredVal').textContent = state.mastered + ' 词'
    $('pageVal').textContent = (state.page + 1) + ' / ' + pages.length
    const tierCount = (t) => rules.filter((r) => !r.retired && r.tier === t).length
    $('stats').innerHTML = '规则 <b>' + rules.length + '</b>（词 ' + tierCount('word') +
      ' · 短语 ' + tierCount('phrase') + '/槽' + quotas.phrases +
      ' · 句 ' + tierCount('sentence') + '/槽' + quotas.sentences +
      ' · 已掌握 ' + retired + '）｜本页替换 <b>' + spans + '</b> 处｜层级 ' +
      (Object.entries(levels).map(([l, n]) => 'A' + l + '×' + n).join(' ') || '—') +
      '｜cov ' + (spatial.coverage >= 1 ? '∞' : spatial.coverage.toFixed(2)) + ' gap ' + spatial.minGap +
      '｜渲染 ' + ms.toFixed(1) + 'ms' +
      (spans === 0 ? '｜<b>本页无匹配</b> <a href="#" id="jumpHit">跳到有替换的页</a>' : '')

    const tierName = {word: '词', phrase: '短语', sentence: '句'}
    // Table order = learning priority (what gets taught first), not the
    // engine's longest-match-first order; retired units sink to the bottom.
    const prioOf = (r) => {
      if (r.retired) return -1
      const e = exprBySource.get(r.from)
      return e ? (BOOST[e.salience] || 0) + e.frequency * e.dispersion : 0
    }
    const listed = rules.slice().sort((a, b) => prioOf(b) - prioOf(a))
    $('rulesCount').textContent = '（' + rules.length + '）'
    $('rulesBody').innerHTML =
      '<table><colgroup><col style="width:2.8em"><col style="width:34%"><col><col style="width:3.4em"></colgroup>' +
      '<tr><th>层</th><th>原文</th><th>译文</th><th>级</th></tr>' +
      listed.slice(0, 60).map((r) => {
        const e = exprBySource.get(r.from)
        const star = e && e.salience === 'signature' ? '<span class="star">★</span>' : ''
        return '<tr><td>' + (tierName[r.tier] || '') + '</td>' +
          '<td class="src" title="' + escapeAttr(r.from) + '">' + star + escapeHtml(r.from) + '</td>' +
          '<td class="tgt" title="' + escapeAttr(String(r.to)) + '">' + escapeHtml(String(r.to)) + '</td>' +
          '<td><span class="lv lv' + r.level + '"' + (r.retired ? ' title="已掌握（退休）"' : '') + '>A' + r.level +
          '</span></td></tr>'
      }).join('') + '</table>' +
      (rules.length > 60 ? '<p>… 仅列前 60 条，共 ' + rules.length + ' 条</p>' : '')
    return spans
  }

  let raf = 0
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render) }

  $('density').addEventListener('input', (e) => { state.density = +e.target.value; schedule() })
  $('mastery').addEventListener('input', (e) => { state.mastery = +e.target.value; schedule() })
  $('mastered').addEventListener('input', (e) => { state.mastered = +e.target.value; schedule() })
  $('hlStyle').addEventListener('change', (e) => { state.style = e.target.value; applyLook() })
  $('glossStyle').addEventListener('change', (e) => { state.gloss = e.target.value; applyLook() })
  $('forceLevel').addEventListener('change', (e) => { state.forceLevel = e.target.value; schedule() })
  $('anno').addEventListener('change', (e) => { state.anno = e.target.checked; applyLook() })
  $('tw').addEventListener('change', (e) => { state.tiers.word = e.target.checked; schedule() })
  $('tp').addEventListener('change', (e) => { state.tiers.phrase = e.target.checked; schedule() })
  $('ts').addEventListener('change', (e) => { state.tiers.sentence = e.target.checked; schedule() })
  $('font').addEventListener('input', (e) => { state.font = +e.target.value; applyLook() })
  $('lh').addEventListener('input', (e) => { state.lh = +e.target.value; applyLook() })
  $('fontFamily').addEventListener('change', (e) => { state.fontFamily = e.target.value; applyLook() })
  const go = (d) => { state.page = Math.min(pages.length - 1, Math.max(0, state.page + d)); schedule(); scrollTo(0, 0) }
  $('prev').addEventListener('click', () => go(-1))
  $('next').addEventListener('click', () => go(1))
  // Jump to the nearest page the CURRENT rule set actually touches — front matter
  // and sparse chapters otherwise make the sliders look inert. Surfaced as a link
  // in the stats line only when the current page has zero matches.
  const hitJump = (dir) => {
    for (let i = state.page + dir; i >= 0 && i < pages.length; i += dir) {
      if (lastRules.some((r) => pages[i].includes(r.from))) {
        state.page = i
        render()
        scrollTo(0, 0)
        return true
      }
    }
    return false
  }
  $('stats').addEventListener('click', (e) => {
    if (e.target.id !== 'jumpHit') return
    e.preventDefault()
    if (!hitJump(1)) hitJump(-1)
  })
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(-1)
    if (e.key === 'ArrowRight') go(1)
  })

  // Tap-to-reveal, same behavior as the app runtime. Spans hold structured
  // children now, so save/restore innerHTML rather than textContent.
  $('content').addEventListener('click', (e) => {
    const el = e.target.closest('.ai-rep')
    if (!el) return
    if (el.getAttribute('data-shown') === 'src') {
      el.innerHTML = el.getAttribute('data-rep')
      el.setAttribute('data-shown', 'rep')
      el.classList.remove('ai-rep-open')
    } else {
      el.setAttribute('data-rep', el.innerHTML)
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
