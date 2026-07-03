import type {LexweaveLlm, LlmJobSpec} from '@lexweave/compile'
import {
  bookIntelligenceJob,
  bookStrategyJob,
  annotateExpressionsJob,
  readingUnitsJob,
  simplifyExpressionsJob,
} from '@lexweave/compile'

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = 'gpt-4.1-mini'

export type OpenAiOptions = {
  apiKey?: string
  model?: string
}

/** OpenAI adapter: strict json_schema structured output via the Responses API. */
export function createOpenAiLlm(options: OpenAiOptions = {}): LexweaveLlm {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set (or pass --api-key)')
  }
  const model = options.model ?? DEFAULT_MODEL

  const runJob = async (spec: LlmJobSpec): Promise<Record<string, unknown>> => {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
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
      }),
    })
    const data = (await response.json()) as Record<string, any>
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `OpenAI request failed with ${response.status}`)
    }
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

  return {
    extractReadingUnits: async (payload) => (await runJob(readingUnitsJob(payload))) as any,
    rateBookIntelligence: async (payload) =>
      ((await runJob(bookIntelligenceJob(payload))) as any).ratings ?? [],
    designBookStrategy: async (digest) => (await runJob(bookStrategyJob(digest))) as any,
    annotateExpressions: async (payload) =>
      ((await runJob(annotateExpressionsJob(payload))) as any).annotations ?? [],
    simplifyExpressions: async (payload) =>
      ((await runJob(simplifyExpressionsJob(payload))) as any).annotations ?? [],
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
