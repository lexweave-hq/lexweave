import type {CorpusDigest, ExpressionSalienceInput, LlmExpressionBatchInput} from '@lexweave/core'
import type {TranslateSegmentsPayload} from './translate'
import type {ReadingUnitsPayload} from './units'

/**
 * Provider-neutral LLM job specs. Each job is a (system, user, jsonSchema)
 * triple; an adapter runs it against any structured-output-capable model
 * (Anthropic tool-use, OpenAI json_schema, a local model, an edge function)
 * and returns the parsed JSON. These prompts ARE the compiler's knowledge —
 * they ship with the package so every adapter behaves identically.
 */
export type LlmJobSpec = {
  name: string
  system: string
  user: string
  /** Strict JSON schema of the expected response object. */
  jsonSchema: Record<string, unknown>
}

const RISK_ENUM = {type: 'string', enum: ['low', 'medium', 'high']}

const READING_UNITS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units', 'baseDensity', 'note'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'span',
          'evidence',
          'translation',
          'tier',
          'keepSource',
          'risk',
          'plotCriticality',
          'reason',
        ],
        properties: {
          span: {type: 'string'},
          evidence: {type: 'string'},
          translation: {type: 'string'},
          tier: {type: 'string', enum: ['word', 'phrase', 'sentence']},
          keepSource: {type: 'boolean'},
          risk: RISK_ENUM,
          plotCriticality: RISK_ENUM,
          reason: {type: ['string', 'null']},
        },
      },
    },
    baseDensity: {type: 'number'},
    note: {type: ['string', 'null']},
  },
}

/**
 * The one required compile job: single-pass, tier-stratified reading-unit
 * extraction. One call per chunk returns a flat inventory of learnable units at
 * three granularities — word / phrase / sentence — each a VERBATIM span the
 * renderer can locate and replace by exact substring match.
 */
export function readingUnitsJob(payload: ReadingUnitsPayload): LlmJobSpec {
  return {
    name: 'reading_units',
    system:
      'You extract a stratified inventory of learnable units — single words, verb-centred action phrases, and whole short sentences — from narrative text for a progressive bilingual immersion reader. Return only grounded JSON that matches the schema.',
    user: [
      'Read the provided chapters and extract units a language learner would benefit from seeing rendered in the target language, at THREE granularities set by the `tier` field: "word", "phrase", "sentence".',
      'CRITICAL — VERBATIM: `span` MUST be copied character-for-character exactly as it appears in the text, INCLUDING any aspect particles (了/着/过), structural particles (的/地/得), and modifiers that sit inside it. NEVER normalise, trim, shorten, or clean it. `evidence` is the full sentence that contains `span`, also copied verbatim, and MUST contain `span` as an exact substring. This verbatim rule is what lets the reader find and replace the unit on the page.',
      'tier "word": one meaningful unit — signature/world or coined vocabulary and power-system terms plus ordinary but learnable content words. A proper noun (person/place/organization name) may be included with keepSource=true; all other words keepSource=false.',
      'tier "phrase": a VERB-centred action chunk — an action verb together with its object or complement, learned as one chunk (点了点头 → nodded, 深吸一口气 → took a deep breath). It MUST contain an action verb. NOT a bare verb, NOT a noun/entity.',
      'tier "sentence": a whole short clause or sentence worth flipping to the target language (还未等他反应过来 → before he could react). A complete thought, usually 8–30 characters.',
      'Aim for a useful SPREAD across all three tiers, not only words. The same region of text may legitimately yield an overlapping word, phrase, and sentence — that is fine; the reader picks by the reader’s level.',
      'translation: ONE natural inline target-language rendering that could stand in place of `span` mid-sentence. Write it lowercase as it reads inline UNLESS it is a genuine proper noun. No alternatives, no slashes, no notes.',
      'keepSource: true ONLY for proper nouns/names that should remain in the source language; false for everything else.',
      'risk: replacement safety. "high" = ambiguous or plot-loaded, must start heavily glossed; "medium" = some care; "low" = safe world/flavour vocabulary (most signature terms are low).',
      'plotCriticality: how much a reader loses if this is shown in the target language and not understood. "high" = carries a clue/twist/load-bearing fact; "medium" = recoverable from context; "low" = ordinary. Most units are low; be sparing with high.',
      'Reject function words, particles, pronouns, quantifiers, and cross-word-boundary fragments. Prefer distinctive, recurring, idiomatic units.',
      'baseDensity (0..1): how aggressively to START replacing for this book — higher for vocabulary-rich genre fiction with many distinctive recurring coinages; lower for dense literary or technical prose.',
      JSON.stringify(payload),
    ].join('\n\n'),
    jsonSchema: READING_UNITS_SCHEMA,
  }
}

const TRANSLATE_SEGMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['translations'],
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'translation'],
        properties: {
          index: {type: 'integer'},
          translation: {type: 'string'},
        },
      },
    },
  },
}

/**
 * Full-translation substrate job: translate every segment of one consecutive
 * passage, glossary-consistent, echoing each segment's index for alignment.
 */
export function translateSegmentsJob(payload: TranslateSegmentsPayload): LlmJobSpec {
  return {
    name: 'segment_translations',
    system:
      'You translate a book segment-by-segment for a progressively bilingual reading edition. Return only JSON that matches the schema.',
    user: [
      "Translate EVERY segment below into the target language — one natural, faithful reading translation per segment, echoing each segment's `index`. Do not merge, split, reorder, or skip segments.",
      'GLOSSARY CONSISTENCY: whenever a glossary source term appears in a segment, render it with exactly the given target form, every time.',
      'The segments are consecutive text from one passage; optional `context` holds the sentences immediately before the first segment. Resolve pronouns, tense, and continuity from that context, and keep proper-noun renderings consistent across segments.',
      'Translate at reading quality — natural target-language prose that could replace the segment in a published translation, not a word-by-word gloss.',
      JSON.stringify(payload),
    ].join('\n\n'),
    jsonSchema: TRANSLATE_SEGMENTS_SCHEMA,
  }
}

const BOOK_INTELLIGENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ratings'],
  properties: {
    ratings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceText', 'salience', 'canonical'],
        properties: {
          sourceText: {type: 'string'},
          salience: {type: 'string', enum: ['signature', 'notable', 'common', 'name', 'none']},
          canonical: {type: 'string'},
        },
      },
    },
  },
}

/** Keyness triage + concept grouping over the mined candidate pool. */
export function bookIntelligenceJob(payload: ExpressionSalienceInput): LlmJobSpec {
  return {
    name: 'book_intelligence',
    system:
      "You analyze a book's mined vocabulary for a language-immersion reader: rate how characteristic each term is of THIS book, and group spelling/inflectional/fragment variants and clear synonyms of one concept under a shared representative form. Return only JSON that matches the schema.",
    user: [
      'You are given a book (title, genre, source/target languages) and candidate terms mined by a naive n-gram scanner, with in-book frequency and dispersion. They are sorted so related forms sit adjacent.',
      'Return exactly one object per input candidate, echoing sourceText verbatim, with a salience label and a canonical concept form.',
      'salience:',
      '- "signature": highly characteristic of THIS book — coined or world/power-system terms, genre-defining jargon.',
      '- "notable": a meaningful, learnable content word, somewhat distinctive but not unique to this book.',
      '- "common": a generic everyday content word usable in any text.',
      '- "name": a proper noun OR any fragment/syllable of one (character/place/org). Judge by reference, not capitalization; prefer "name" for ambiguous transliterated fragments.',
      '- "none": not worth learning or replacing — function words, particles, measure words, or cross-word-boundary fragments.',
      'Judge distinctiveness by KEYNESS, not raw frequency.',
      "canonical: the shared representative surface form of this term's CONCEPT. If the candidate is a spelling/inflectional/fragment variant, or a clear synonym, of another candidate that a learner should treat as ONE unit, set canonical to the cleanest base form of that concept — preferably a form that itself appears among the candidates. If the term stands alone, set canonical = sourceText. Only merge genuine variants of the SAME concept; never merge unrelated words.",
      JSON.stringify(payload),
    ].join('\n\n'),
    jsonSchema: BOOK_INTELLIGENCE_SCHEMA,
  }
}

const BOOK_STRATEGY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baseDensity', 'promoteNotable', 'note'],
  properties: {
    baseDensity: {type: 'number'},
    promoteNotable: {type: 'boolean'},
    note: {type: ['string', 'null']},
  },
}

/** Per-book replacement strategy from a cheap, document-free corpus digest. */
export function bookStrategyJob(digest: CorpusDigest): LlmJobSpec {
  return {
    name: 'book_strategy',
    system:
      'You design a progressive in-place replacement strategy for a language-immersion reader, tuned to ONE specific book. Return only JSON that matches the schema.',
    user: [
      'Given a book profile, its corpus stats, and its most characteristic mined terms, design how aggressively and in what shape to replace words for a reader learning through immersion.',
      'baseDensity (0..1): how aggressively to START replacing. Higher for vocabulary-rich genre fiction with many distinctive coinages a reader re-encounters; lower for dense, literary, or technical prose where each swap costs more comprehension. This is an ANCHOR that live reading feedback nudges — NOT a fixed percentage or per-chapter quota.',
      'promoteNotable: true when the book has few genuinely signature/coined terms, so meaningful "notable" vocabulary should also surface early rather than leaving the first pages bare.',
      'note: one short sentence explaining your choice.',
      JSON.stringify(digest),
    ].join('\n\n'),
    jsonSchema: BOOK_STRATEGY_SCHEMA,
  }
}

const REPLACEMENT_CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetLanguage', 'targetText', 'register', 'confidence', 'notes'],
  properties: {
    targetLanguage: {type: 'string'},
    targetText: {type: 'string'},
    register: {type: 'string', enum: ['plain', 'literary', 'technical']},
    confidence: {type: 'number'},
    notes: {type: ['string', 'null']},
  },
}

const annotationItemSchema = (withExplanation: boolean) => ({
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceText',
    'kind',
    'isContentWord',
    'targetCandidates',
    'replacementRisk',
    'plotCriticality',
    'suggestedStage',
    'shouldKeepSource',
    'reason',
    ...(withExplanation ? ['explanation'] : []),
  ],
  properties: {
    sourceText: {type: 'string'},
    kind: {type: 'string', enum: ['word', 'phrase', 'term', 'name', 'sentence_pattern']},
    isContentWord: {type: 'boolean'},
    targetCandidates: {type: 'array', items: REPLACEMENT_CANDIDATE_SCHEMA},
    replacementRisk: RISK_ENUM,
    plotCriticality: RISK_ENUM,
    suggestedStage: {type: 'integer'},
    shouldKeepSource: {type: 'boolean'},
    reason: {type: ['string', 'null']},
    ...(withExplanation ? {explanation: {type: ['string', 'null']}} : {}),
  },
})

const annotationBatchSchema = (withExplanation: boolean) => ({
  type: 'object',
  additionalProperties: false,
  required: ['annotations'],
  properties: {
    annotations: {type: 'array', items: annotationItemSchema(withExplanation)},
  },
})

/** Translate-mapper enrichment: source expression → target-language candidates. */
export function annotateExpressionsJob(payload: LlmExpressionBatchInput): LlmJobSpec {
  return {
    name: 'expression_annotations',
    system:
      'You annotate expression candidates for a progressive language immersion engine. Return only JSON that matches the schema.',
    user: [
      'Annotate these expression candidates.',
      'Do not rewrite source text. Provide stable target candidates and risk labels only.',
      'The candidates come from a naive n-gram scanner, so many are NOT real words: function words, particles, pronouns, conjunctions, or fragments that cut across word boundaries. Set isContentWord=false for any such item — it must be a standalone, meaningful content word or phrase (noun, verb, adjective, named entity, idiom) that a language learner would actually want to learn. When isContentWord=false, also set shouldKeepSource=true.',
      'A high risk expression should be preserved unless context makes it clearly safe.',
      'suggestedStage is a 1-5 ladder of how hard a word is to learn and how risky it is to replace — NOT how common it is. Distinctive, book-specific vocabulary that defines the work may sit at stage 1-2 even if it is technical, because surfacing it is the point of the immersion. Reserve higher stages for genuinely ambiguous, high-friction, or plot-sensitive items. Do NOT push a word to stage 1 just because it is frequent or generic.',
      'plotCriticality is a SEPARATE axis from replacementRisk: it measures how much a reader would lose if this word were shown in the target language and they did not understand it. "high" = the word carries a plot point, clue, twist, or a piece of information the reader must grasp to follow the story (the engine will keep it heavily glossed); "medium" = meaningful but recoverable from context; "low" = ordinary world/flavor vocabulary whose exact meaning is not load-bearing. Most items are low. Be sparing with high.',
      'Each targetCandidate.targetText must be ONE single expression that can replace the source inline. Never put alternatives, synonyms, or slashes in a single targetText. If multiple options exist, return them as separate array items in targetCandidates.',
      JSON.stringify(payload),
    ].join('\n\n'),
    jsonSchema: annotationBatchSchema(false),
  }
}

/** Simplify-mapper enrichment: source → plainer phrase in the SAME language. */
export function simplifyExpressionsJob(payload: LlmExpressionBatchInput): LlmJobSpec {
  return {
    name: 'expression_simplifications',
    system:
      'You rewrite difficult expressions as a simpler, plainer phrase in the SAME language as the source, for a progressive in-language immersion reader. Return only JSON that matches the schema.',
    user: [
      'Simplify these expression candidates for a reader who finds them dense or obscure (e.g. academic papers, technical jargon, archaic wording).',
      'For each candidate, targetCandidates must be a simpler, plainer phrase IN THE SAME LANGUAGE as the source that can replace it inline. Set each targetCandidate.targetLanguage to the SOURCE language and register to "plain".',
      'Provide a one-sentence `explanation` in the source language for an optional detail panel.',
      'The candidates come from a naive n-gram scanner, so many are NOT real words: function words, particles, or fragments that cut across word boundaries. Set isContentWord=false (and shouldKeepSource=true) for any such item.',
      'Keep proper nouns and indispensable terms-of-art in source (shouldKeepSource=true) when no simpler wording preserves the meaning.',
      'suggestedStage is a 1-5 ladder of how hard / risky an item is to simplify, NOT how common it is.',
      'plotCriticality measures how much a reader would lose if this item were simplified and they misread the plainer wording: "high" = load-bearing for the argument/meaning, "medium" = recoverable from context, "low" = ordinary wording whose exact form is not essential. Most items are low; be sparing with high.',
      'Each targetText must be ONE single phrase — never alternatives, synonym lists, or slashes.',
      JSON.stringify(payload),
    ].join('\n\n'),
    jsonSchema: annotationBatchSchema(true),
  }
}
