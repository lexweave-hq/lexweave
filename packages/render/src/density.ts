import type {DensityOptions} from './types'

/**
 * Map the flow-budget density (0..1) to the render-time spatial controls. A low
 * density (struggling reader) → wide gaps + a low coverage ceiling → sparse,
 * well-spaced words; a high density (advanced) → no gap + a high ceiling → whole
 * phrases/sentences fill the page. Centralised so every renderer agrees.
 */
export function densityRenderOptions(density: number): DensityOptions {
  const d = Number.isFinite(density) ? Math.min(1, Math.max(0, density)) : 0.55
  return {
    // Full density means FULL: coverage uncaps so a complete-translation
    // substrate renders the whole page in the target language. Below that the
    // ceiling stays at 0.95 so at least a sliver of source remains.
    coverage: d >= 0.99 ? 1 : Math.min(0.95, Math.max(0.15, 0.15 + d * 0.8)),
    minGap: Math.round((1 - d) * 24),
  }
}
