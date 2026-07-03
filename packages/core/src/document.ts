import type {ContentDocument, ContentKind, Section, Segment, TextSpan} from './types'

type CreateDocumentInput = {
  id: string
  rawText: string
  title?: string
  kind?: ContentKind
  sourceLanguage: string
  defaultTargetLanguage: string
}

type ChapterInput = {
  title?: string
  /** Plain text with paragraphs separated by blank lines (\n\n). */
  text: string
}

type CreateDocumentFromChaptersInput = {
  id: string
  title?: string
  kind?: ContentKind
  sourceLanguage: string
  defaultTargetLanguage: string
  chapters: ChapterInput[]
}

const chapterHeadingPattern =
  /^(第[\s\d一二三四五六七八九十百千万零〇两]+[章节回卷集部篇].*|chapter\s+\d+.*)$/i
const maxSegmentCharacterLength = 1200

export function createDocumentFromPlainText(input: CreateDocumentInput): ContentDocument {
  const sections = splitIntoSections(input.rawText).map((section, sectionIndex) =>
    createSection(input.id, section.title, section.body, sectionIndex)
  )

  return {
    id: input.id,
    title: input.title,
    kind: input.kind ?? 'novel',
    sourceLanguage: input.sourceLanguage,
    defaultTargetLanguage: input.defaultTargetLanguage,
    sections,
  }
}

/**
 * Build a document from chapters already split by a real parser (foliate-js).
 * Chapter boundaries are trusted as-is — only paragraph/segment splitting is
 * applied within each chapter (shared with createDocumentFromPlainText).
 */
export function createDocumentFromChapters(
  input: CreateDocumentFromChaptersInput
): ContentDocument {
  const sections = input.chapters.map((chapter, sectionIndex) =>
    createSection(input.id, chapter.title, chapter.text, sectionIndex)
  )

  return {
    id: input.id,
    title: input.title,
    kind: input.kind ?? 'novel',
    sourceLanguage: input.sourceLanguage,
    defaultTargetLanguage: input.defaultTargetLanguage,
    sections,
  }
}

function splitIntoSections(rawText: string): {title?: string; body: string}[] {
  const normalized = rawText.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return [{body: ''}]
  }

  const lines = normalized.split('\n')
  const sections: {title?: string; bodyLines: string[]}[] = []
  let current: {title?: string; bodyLines: string[]} = {bodyLines: []}

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && chapterHeadingPattern.test(trimmed) && current.bodyLines.length > 0) {
      sections.push(current)
      current = {title: trimmed, bodyLines: []}
      continue
    }

    if (trimmed && chapterHeadingPattern.test(trimmed) && current.bodyLines.length === 0) {
      current.title = trimmed
      continue
    }

    current.bodyLines.push(line)
  }

  sections.push(current)

  return sections.map((section, index) => ({
    title: section.title ?? `Section ${index + 1}`,
    body: section.bodyLines.join('\n').trim(),
  }))
}

function createSection(
  documentId: string,
  title: string | undefined,
  body: string,
  sectionIndex: number
): Section {
  const sectionId = `${documentId}:section:${sectionIndex}`
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  const segments = (paragraphs.length > 0 ? paragraphs : body ? [body] : []).flatMap(
    splitLongSegment
  )

  return {
    id: sectionId,
    title,
    order: sectionIndex,
    segments: segments.map((sourceText, segmentIndex) =>
      createSegment(sectionId, sourceText, segmentIndex)
    ),
  }
}

function createSegment(sectionId: string, sourceText: string, segmentIndex: number): Segment {
  return {
    id: `${sectionId}:segment:${segmentIndex}`,
    sectionId,
    order: segmentIndex,
    sourceText,
    spans: createBaseSpans(sourceText),
  }
}

function splitLongSegment(sourceText: string): string[] {
  if (sourceText.length <= maxSegmentCharacterLength) {
    return [sourceText]
  }

  const parts: string[] = []
  let cursor = 0

  while (cursor < sourceText.length) {
    const idealEnd = Math.min(cursor + maxSegmentCharacterLength, sourceText.length)
    if (idealEnd === sourceText.length) {
      parts.push(sourceText.slice(cursor).trim())
      break
    }

    const slice = sourceText.slice(cursor, idealEnd)
    const boundary = Math.max(
      slice.lastIndexOf('。'),
      slice.lastIndexOf('！'),
      slice.lastIndexOf('？'),
      slice.lastIndexOf('.'),
      slice.lastIndexOf('!'),
      slice.lastIndexOf('?')
    )
    const end = cursor + (boundary > maxSegmentCharacterLength * 0.45 ? boundary + 1 : slice.length)
    parts.push(sourceText.slice(cursor, end).trim())
    cursor = end
  }

  return parts.filter(Boolean)
}

function createBaseSpans(sourceText: string): TextSpan[] {
  if (!sourceText) {
    return []
  }

  return [{start: 0, end: sourceText.length, text: sourceText}]
}
