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

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5'

export type AnthropicOptions = {
  apiKey?: string
  model?: string
  /** Model for the extraction pass only (defaults to `model`). */
  extractModel?: string
  maxOutputTokens?: number
}

/**
 * Anthropic adapter: every job runs as a forced tool call whose input schema is
 * the job's JSON schema, so the response is structured by construction.
 */
export function createAnthropicLlm(options: AnthropicOptions = {}): LexweaveLlm {
  // Trim first: keys pasted from CRLF .env files carry a trailing \r that
  // would corrupt the HTTP header just as badly as placeholder text.
  const apiKey = (options.apiKey ?? process.env.ANTHROPIC_API_KEY)?.trim()
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set (or pass --api-key)')
  }
  // HTTP headers reject non-Latin-1 and control characters — catch pasted
  // placeholders (e.g. 你的key) with a clear message, not a fetch error.
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error(
      'ANTHROPIC_API_KEY contains characters that cannot go into an HTTP header ' +
        '(placeholder text, spaces, or a stray newline). Set it to your real key ' +
        '(starts with "sk-ant-") from console.anthropic.com.'
    )
  }
  const model = options.model ?? ANTHROPIC_DEFAULT_MODEL
  const extractModel = options.extractModel ?? model
  const maxTokens = options.maxOutputTokens ?? 8192

  const runJob = async (
    spec: LlmJobSpec,
    jobModel: string = model
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: jobModel,
        max_tokens: maxTokens,
        system: spec.system,
        messages: [{role: 'user', content: spec.user}],
        tools: [
          {
            name: spec.name,
            description: 'Return the structured result.',
            input_schema: spec.jsonSchema,
          },
        ],
        tool_choice: {type: 'tool', name: spec.name},
      }),
    })
    const data = (await response.json()) as Record<string, any>
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `Anthropic request failed with ${response.status}`)
    }
    const toolUse = (data.content ?? []).find((block: any) => block.type === 'tool_use')
    if (!toolUse?.input) {
      throw new Error('Anthropic response did not include a tool_use result')
    }
    return {
      ...toolUse.input,
      usage: {
        inputTokens: Number(data.usage?.input_tokens ?? 0),
        outputTokens: Number(data.usage?.output_tokens ?? 0),
        totalTokens:
          Number(data.usage?.input_tokens ?? 0) + Number(data.usage?.output_tokens ?? 0),
      },
    }
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
