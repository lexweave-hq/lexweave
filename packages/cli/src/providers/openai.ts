import type {LexweaveLlm, LlmJobSpec} from '@lexweave/compile'
import {
  bookContextJob,
  bookIntelligenceJob,
  bookStrategyJob,
  annotateExpressionsJob,
  readingUnitsJob,
  simplifyExpressionsJob,
  translateSegmentsJob,
} from '@lexweave/compile'
import {createOpenAiBatchRunner, type OpenAiBatchRunner} from './openai-batch'

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses'
export const OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini'

// The two O(book) jobs worth routing through the Batch API. Single-shot jobs
// (brief, strategy) stay synchronous: batching them saves cents but adds a
// full submit→poll round-trip to a serial stage of the pipeline.
const BATCHABLE_JOBS = new Set(['reading_units', 'segment_translations'])

export type OpenAiOptions = {
  apiKey?: string
  model?: string
  /** Model for the extraction pass only (defaults to `model`). */
  extractModel?: string
  /** Route the volume jobs (extraction, translation) through the OpenAI
   * Batch API — 50% of synchronous token prices, results within minutes to
   * hours. Pair with a high pipeline concurrency so requests aggregate into
   * large submissions. */
  batchApi?: boolean
}

// gpt-5-family models spend hidden reasoning tokens (billed as output) by
// default — pointless for structured extraction/translation jobs, so pin the
// effort floor. The enum differs by generation: 5.0 has 'minimal', 5.1+ 'none'.
function reasoningFor(model: string): {effort: string} | undefined {
  if (/^gpt-5(\.\d)/.test(model)) return {effort: 'none'}
  if (/^gpt-5/.test(model)) return {effort: 'minimal'}
  return undefined
}

/** OpenAI adapter: strict json_schema structured output via the Responses API. */
export function createOpenAiLlm(options: OpenAiOptions = {}): LexweaveLlm {
  // Trim first: keys pasted from CRLF .env files carry a trailing \r that
  // would corrupt the HTTP header just as badly as placeholder text.
  const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY)?.trim()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set (or pass --api-key)')
  }
  // HTTP headers reject non-Latin-1 and control characters — catch pasted
  // placeholders with a clear message, not a fetch error.
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error(
      'OPENAI_API_KEY contains characters that cannot go into an HTTP header ' +
        '(placeholder text, spaces, or a stray newline). Set it to your real key ' +
        'from platform.openai.com.'
    )
  }
  const model = options.model ?? OPENAI_DEFAULT_MODEL
  const extractModel = options.extractModel ?? model
  const batchRunner: OpenAiBatchRunner | null = options.batchApi
    ? createOpenAiBatchRunner({apiKey})
    : null

  const buildBody = (spec: LlmJobSpec, jobModel: string): Record<string, unknown> => {
    const reasoning = reasoningFor(jobModel)
    return {
      model: jobModel,
      ...(reasoning ? {reasoning} : {}),
      input: [
        {role: 'system', content: [{type: 'input_text', text: spec.system}]},
        {role: 'user', content: [{type: 'input_text', text: spec.user}]},
      ],
      text: {
        format: {
          type: 'json_schema',
          name: spec.name,
          strict: true,
          schema: spec.jsonSchema,
        },
      },
      // Routing hint for OpenAI's automatic prefix caching: all batches of a
      // job share a static prefix (instructions + book + glossary + brief),
      // so steering same-job requests to the same cache raises hit rates on
      // synchronous runs. Harmless where caching does not apply.
      prompt_cache_key: `lexweave:${spec.name}:${jobModel}`,
    }
  }

  const parseJobResponse = (data: Record<string, any>): Record<string, unknown> => {
    const outputText = extractOutputText(data)
    if (!outputText) {
      throw new Error('OpenAI response did not include JSON output text')
    }
    return {
      ...JSON.parse(outputText),
      usage: {
        inputTokens: Number(data.usage?.input_tokens ?? 0),
        outputTokens: Number(data.usage?.output_tokens ?? 0),
        totalTokens: Number(data.usage?.total_tokens ?? 0),
      },
    }
  }

  const runJob = async (
    spec: LlmJobSpec,
    jobModel: string = model
  ): Promise<Record<string, unknown>> => {
    const body = buildBody(spec, jobModel)
    if (batchRunner && BATCHABLE_JOBS.has(spec.name)) {
      return parseJobResponse(await batchRunner.run(body))
    }
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = (await response.json()) as Record<string, any>
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `OpenAI request failed with ${response.status}`)
    }
    return parseJobResponse(data)
  }

  return {
    extractReadingUnits: async (payload) =>
      (await runJob(readingUnitsJob(payload), extractModel)) as any,
    rateBookIntelligence: async (payload) =>
      ((await runJob(bookIntelligenceJob(payload))) as any).ratings ?? [],
    designBookStrategy: async (digest) => (await runJob(bookStrategyJob(digest))) as any,
    annotateExpressions: async (payload) =>
      ((await runJob(annotateExpressionsJob(payload))) as any).annotations ?? [],
    simplifyExpressions: async (payload) =>
      ((await runJob(simplifyExpressionsJob(payload))) as any).annotations ?? [],
    translateSegments: async (payload) => (await runJob(translateSegmentsJob(payload))) as any,
    designTranslationContext: async (payload) => (await runJob(bookContextJob(payload))) as any,
  }
}

function extractOutputText(data: Record<string, any>): string | null {
  if (typeof data.output_text === 'string') {
    return data.output_text
  }
  const output = Array.isArray(data.output) ? data.output : []
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : []
    for (const contentItem of content) {
      if (typeof contentItem.text === 'string') {
        return contentItem.text
      }
    }
  }
  return null
}
