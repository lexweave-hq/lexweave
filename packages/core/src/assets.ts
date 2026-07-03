import {z} from 'zod'
import type {
  BookStrategy,
  ContentKind,
  ExpressionSalience,
  ReplacementCandidate,
  ReplacementRisk,
} from './types'
import type {MapperKind} from './mappers'

/**
 * The compiled "Language Unit Graph" rows — the durable asset a book compiles
 * into, independent of any storage engine. A host app persists these however it
 * likes (SQLite, Postgres, JSON); the shapes here are the interchange format.
 */

/** One learnable surface form mined from the book (per-surface row). */
export type UnitCandidate = {
  canonicalSource: string
  sourceText: string
  kind: string
  frequency: number
  dispersion: number
  salience: ExpressionSalience
  /** Canonical of the concept this candidate belongs to (its own id if standalone). */
  conceptCanonical: string
}

/** A representative location of a candidate in the book (verbatim span coords). */
export type UnitOccurrence = {
  canonicalSource: string
  sectionIdx: number
  segmentIdx: number
  start: number
  end: number
  before?: string
  text?: string
  after?: string
}

/** The replacement policy for one concept, under one producer version. */
export type UnitAnnotation = {
  canonicalSource: string
  producer: string
  translations: ReplacementCandidate[]
  risk: ReplacementRisk
  /** Plot-comprehension cost — caps the unit's action level. Defaults to 'low'. */
  plotCriticality: ReplacementRisk
  replacementStage: number
  shouldKeepSource: boolean
  reason?: string
  /** Which pluggable mapper produced this replacement. */
  mapperKind: MapperKind
  /** Optional longer plain-language gloss (simplify mapper). */
  explanation?: string
}

export type BookBundleMeta = {
  contentHash?: string
  title?: string
  kind: ContentKind
  sourceLanguage: string
  targetLanguage: string
  sourceCharCount: number
  sectionCount: number
  segmentCount: number
}

export const BOOK_BUNDLE_FORMAT = 'lexweave.bundle'
export const BOOK_BUNDLE_VERSION = 1

/**
 * The portable compile artifact: everything a reader needs to render a
 * progressively bilingual edition of ONE book, decoupled from learner state
 * (which is per-user and lives with the host). Compile once, render many.
 */
export type BookBundle = {
  format: typeof BOOK_BUNDLE_FORMAT
  version: typeof BOOK_BUNDLE_VERSION
  producer: string
  book: BookBundleMeta
  strategy: BookStrategy
  candidates: UnitCandidate[]
  occurrences: UnitOccurrence[]
  annotations: UnitAnnotation[]
}

const salienceSchema = z.enum(['signature', 'notable', 'common', 'name', 'none'])
const riskSchema = z.enum(['low', 'medium', 'high'])

const unitCandidateSchema = z.object({
  canonicalSource: z.string().min(1),
  sourceText: z.string().min(1),
  kind: z.string().min(1),
  frequency: z.number().nonnegative(),
  dispersion: z.number().min(0).max(1),
  salience: salienceSchema,
  conceptCanonical: z.string().min(1),
})

const unitOccurrenceSchema = z.object({
  canonicalSource: z.string().min(1),
  sectionIdx: z.number().int().nonnegative(),
  segmentIdx: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  before: z.string().optional(),
  text: z.string().optional(),
  after: z.string().optional(),
})

const unitAnnotationSchema = z.object({
  canonicalSource: z.string().min(1),
  producer: z.string().min(1),
  translations: z.array(
    z.object({
      targetLanguage: z.string().min(1),
      targetText: z.string().min(1),
      register: z.enum(['plain', 'literary', 'technical']),
      confidence: z.number().min(0).max(1),
      notes: z.string().optional(),
    })
  ),
  risk: riskSchema,
  plotCriticality: riskSchema,
  replacementStage: z.number().int().min(1),
  shouldKeepSource: z.boolean(),
  reason: z.string().optional(),
  mapperKind: z.enum(['translate', 'simplify']),
  explanation: z.string().optional(),
})

export const bookBundleSchema = z.object({
  format: z.literal(BOOK_BUNDLE_FORMAT),
  version: z.literal(BOOK_BUNDLE_VERSION),
  producer: z.string().min(1),
  book: z.object({
    contentHash: z.string().optional(),
    title: z.string().optional(),
    kind: z.enum(['novel', 'book', 'paper', 'report', 'transcript']),
    sourceLanguage: z.string().min(1),
    targetLanguage: z.string().min(1),
    sourceCharCount: z.number().nonnegative(),
    sectionCount: z.number().nonnegative(),
    segmentCount: z.number().nonnegative(),
  }),
  strategy: z.object({
    baseDensity: z.number().min(0).max(1),
    promoteNotable: z.boolean(),
    note: z.string().optional(),
  }),
  candidates: z.array(unitCandidateSchema),
  occurrences: z.array(unitOccurrenceSchema),
  annotations: z.array(unitAnnotationSchema),
})

/** Parse + validate a serialized bundle (throws with a zod error on mismatch). */
export function parseBookBundle(value: unknown): BookBundle {
  return bookBundleSchema.parse(
    typeof value === 'string' ? JSON.parse(value) : value
  ) as BookBundle
}
