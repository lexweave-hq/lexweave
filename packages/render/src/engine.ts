import type {
  DensityOptions,
  MatchRenderer,
  ReplacementRule,
  TransformResult,
} from './types'

export const escapeHtml = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;')

/**
 * Action level → what the reader actually sees in place of the source. The
 * flow budget already decided this word surfaces; the level decides how much
 * scaffolding it carries, shedding help as the reader masters it:
 *   A1 source primary + target gloss   灵石（spirit stone）
 *   A2 target primary + source gloss    spirit stone（灵石）
 *   A3 target only (tap reveals source) spirit stone
 *   A4 target only, no affordance       spirit stone   (fully immersed)
 */
export const levelDisplay = (from: string, to: string, level?: number): string => {
  const lv = typeof level === 'number' ? level : 3
  if (lv <= 1) return `${from}（${to}）`
  if (lv === 2) return `${to}（${from}）`
  return to
}

// Is `ch` a CJK ideograph (not punctuation)? Used for "pangu" spacing so we add
// a gap between Han characters and Latin/digits but NOT before CJK punctuation.
const isCjk = (ch: string): boolean => {
  if (!ch) return false
  const c = ch.codePointAt(0)!
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
    (c >= 0x3400 && c <= 0x4dbf) || // Extension A
    (c >= 0xf900 && c <= 0xfaff) // Compatibility Ideographs
  )
}
const isLatinAlnum = (ch: string): boolean => !!ch && ch >= ' ' && /[0-9A-Za-z]/.test(ch)

// Perceived width of a string on the page: a Han ideograph is roughly twice as
// wide as a Latin glyph. The coverage budget counts what the reader SEES — an
// injected English display is far longer in glyphs than the CJK span it covers,
// so counting source chars would under-bill A1/A2 glosses by 2–4× and let a
// "12% coverage" page render a third English.
const visualWidth = (s: string): number => {
  let w = 0
  for (const ch of s) w += isCjk(ch) ? 2 : 1
  return w
}
// A space belongs between a Han character and adjacent Latin/digits, in either
// order — so an injected English word reads "无法 enter 脑海", not "无法enter脑海".
export const needsPanguSpace = (a: string, b: string): boolean =>
  (isCjk(a) && isLatinAlnum(b)) || (isLatinAlnum(a) && isCjk(b))

// Longest `from` first so the single-pass matcher prefers whole phrases over
// their own substrings.
export const sortReplacementRules = (rules: ReplacementRule[] | null | undefined): ReplacementRule[] =>
  (Array.isArray(rules) ? rules.filter((r) => r && r.from && r.to != null) : []).sort(
    (a, b) => b.from.length - a.from.length
  )

const replacementKey = (r: ReplacementRule): string => `${r.from}\u0000${r.to}`

/** The default renderer: the `.ai-rep` span the reader runtime styles + taps. */
export const htmlMatchRenderer: MatchRenderer = ({from, level, display}) =>
  `<span class="ai-rep" data-level="${level}" data-src="${escapeAttr(from)}">${escapeHtml(display)}</span>`

/** Plain-text renderer: just the level-shaped display text, no markup. */
export const plainMatchRenderer: MatchRenderer = ({display}) => display

type SectionBudget = {
  limit: number
  replaced: number
  lastEnd: number
  cursor: number
}

export type ReplacementEngineOptions = {
  rules?: ReplacementRule[]
  coverage?: number
  minGap?: number
  renderMatch?: MatchRenderer
}

export type ReplacementEngine = {
  setRules(rules: ReplacementRule[]): void
  getRules(): ReplacementRule[]
  /** Absent fields leave the current value untouched (both default to OFF). */
  setDensity(density?: DensityOptions | null): void
  /** Reset the per-rule maxCount usage window (call when a new render begins). */
  resetUsage(): void
  /**
   * Replacement injection over one section of markup (XHTML/HTML) or plain
   * text. Only touches TEXT runs, never tag/attribute interiors, and never
   * rescans markup it just emitted: the input is split into tag vs text runs
   * and each text run gets a single left-to-right, longest-match-first pass.
   * A per-section spatial budget (coverage + minGap, in visible-char coords)
   * thins the matches so a beginner's page is not lit up on every sentence.
   */
  transformSection(markup: string): TransformResult
}

export function createReplacementEngine(options: ReplacementEngineOptions = {}): ReplacementEngine {
  let rules = sortReplacementRules(options.rules ?? [])
  let usage = new Map<string, number>()
  let coverage = typeof options.coverage === 'number' ? options.coverage : 1
  let minGap = typeof options.minGap === 'number' ? options.minGap : 0
  const renderMatch = options.renderMatch ?? htmlMatchRenderer

  const transformSection = (markup: string): TransformResult => {
    if (typeof markup !== 'string' || !rules.length) {
      return {output: markup, appliedSources: []}
    }
    const applied = new Set<string>()
    // Per-section spatial budget over the section's VISIBLE width (markup
    // stripped, CJK≈2/Latin≈1). limit=Infinity when coverage is uncapped so the
    // checks are free. Shared across every text run of this section.
    const budget: SectionBudget = {
      limit:
        coverage >= 1 ? Infinity : Math.floor(visualWidth(markup.replace(/<[^>]*>/g, '')) * coverage),
      replaced: 0,
      lastEnd: -Infinity,
      cursor: 0,
    }
    const output = markup.replace(/<[^>]*>|[^<]+/g, (chunk) =>
      chunk.charCodeAt(0) === 0x3c /* '<' */ ? chunk : replaceTextRun(chunk, budget, applied)
    )
    return {output, appliedSources: [...applied]}
  }

  const replaceTextRun = (text: string, budget: SectionBudget, applied: Set<string>): string => {
    let out = ''
    let last = '' // last visible (non-markup) char emitted, for pangu spacing
    let i = 0
    const emit = (markup: string, firstChar: string, lastChar: string) => {
      if (last && needsPanguSpace(last, firstChar)) out += ' '
      out += markup
      last = lastChar
    }
    while (i < text.length) {
      let matched: ReplacementRule | null = null
      let display = ''
      // rules are kept sorted longest-first, so the first hit is the longest
      // match at this position.
      for (const r of rules) {
        if (!r || !r.from || r.to == null) continue
        if (!text.startsWith(r.from, i)) continue
        const key = replacementKey(r)
        const limit =
          typeof r.maxCount === 'number' && r.maxCount > 0 ? Math.floor(r.maxCount) : Infinity
        if ((usage.get(key) ?? 0) >= limit) continue
        const candidateDisplay = levelDisplay(
          r.from,
          String(r.to),
          typeof r.level === 'number' ? r.level : 3
        )
        // Spatial density budget: skip a candidate that sits too close to the
        // previous replacement (min-gap) or whose DISPLAY width would push
        // section coverage past the cap. Retired (mastered) rules are
        // budget-transparent: they render as bare target text the reader
        // already knows, so they cost no attention and must never crowd out —
        // or be crowded out by — words still being learned.
        if (!r.retired) {
          const pos = budget.cursor + i
          if (pos - budget.lastEnd < minGap) continue
          if (budget.replaced + visualWidth(candidateDisplay) > budget.limit) continue
        }
        matched = r
        display = candidateDisplay
        break
      }
      if (matched) {
        const key = replacementKey(matched)
        usage.set(key, (usage.get(key) ?? 0) + 1)
        if (!matched.retired) {
          const pos = budget.cursor + i
          budget.lastEnd = pos + matched.from.length
          budget.replaced += visualWidth(display)
        }
        applied.add(matched.from)
        const lv = typeof matched.level === 'number' ? matched.level : 3
        emit(
          renderMatch({
            from: matched.from,
            to: String(matched.to),
            level: lv,
            display,
            retired: !!matched.retired,
          }),
          display[0],
          display[display.length - 1]
        )
        i += matched.from.length
      } else {
        const ch = text[i]
        emit(ch, ch, ch)
        i += 1
      }
    }
    // Advance the section-global visible cursor past this run so min-gap /
    // coverage measure distance across the whole section, not just one run.
    budget.cursor += text.length
    return out
  }

  return {
    setRules(next) {
      rules = sortReplacementRules(next)
    },
    getRules() {
      return rules
    },
    setDensity(density) {
      if (density && typeof density.coverage === 'number') coverage = density.coverage
      if (density && typeof density.minGap === 'number') minGap = density.minGap
    },
    resetUsage() {
      usage = new Map()
    },
    transformSection,
  }
}

/**
 * One-shot convenience for plain text or a standalone HTML fragment: fresh
 * usage window, one section, done.
 */
export function transformText(
  text: string,
  rules: ReplacementRule[],
  options: {density?: DensityOptions; renderMatch?: MatchRenderer} = {}
): TransformResult {
  const engine = createReplacementEngine({
    rules,
    coverage: options.density?.coverage,
    minGap: options.density?.minGap,
    renderMatch: options.renderMatch ?? plainMatchRenderer,
  })
  return engine.transformSection(text)
}
