const OPENAI_API_BASE = 'https://api.openai.com/v1'

/**
 * OpenAI Batch API runner: aggregates individual /v1/responses request bodies
 * into JSONL batch jobs at 50% of synchronous token prices.
 *
 * Design: callers `run(body)` exactly as if calling the sync endpoint and get
 * a Promise of the raw Responses body. Pending requests are flushed as one
 * OpenAI batch when either `maxRequests` accumulate or `flushMs` of quiet
 * passes, so the compile pipeline's worker pool needs no batch awareness —
 * with a high concurrency setting, thousands of in-flight calls aggregate
 * into a handful of large batch submissions that OpenAI processes in
 * parallel. Per-request failures reject individually; the pipeline's
 * existing retry ladder re-enqueues them into the next micro-batch.
 */
export type OpenAiBatchRunner = {
  run(body: Record<string, unknown>): Promise<Record<string, any>>
}

export type OpenAiBatchRunnerOptions = {
  apiKey: string
  /** Requests per batch submission. Sized so one submission (~5k tokens per
   * request) stays under low-tier enqueued-token quotas; oversize submissions
   * would never be accepted no matter how long we wait. */
  maxRequests?: number
  /** Quiet time before a partial buffer is flushed anyway. */
  flushMs?: number
  /** Poll interval while a submitted batch is in progress. */
  pollMs?: number
  log?: (message: string) => void
}

type Pending = {
  body: Record<string, unknown>
  resolve: (value: Record<string, any>) => void
  reject: (error: Error) => void
}

export function createOpenAiBatchRunner(options: OpenAiBatchRunnerOptions): OpenAiBatchRunner {
  const apiKey = options.apiKey
  const maxRequests = options.maxRequests ?? 200
  const flushMs = options.flushMs ?? 2000
  const pollMs = options.pollMs ?? 15_000
  const log = options.log ?? ((message: string) => console.error(message))

  let pending: Pending[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const api = async (path: string, init: RequestInit = {}): Promise<Record<string, any>> => {
    const response = await fetch(`${OPENAI_API_BASE}${path}`, {
      ...init,
      headers: {Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {})},
    })
    const data = (await response.json()) as Record<string, any>
    if (!response.ok) {
      const error = new Error(
        data?.error?.message ?? `OpenAI ${path} failed with ${response.status}`
      ) as Error & {status?: number}
      error.status = response.status
      throw error
    }
    return data
  }

  const apiText = async (path: string): Promise<string> => {
    const response = await fetch(`${OPENAI_API_BASE}${path}`, {
      headers: {Authorization: `Bearer ${apiKey}`},
    })
    if (!response.ok) {
      throw new Error(`OpenAI ${path} failed with ${response.status}`)
    }
    return response.text()
  }

  const submit = async (jobs: Pending[]): Promise<void> => {
    try {
      const jsonl = jobs
        .map((job, index) =>
          JSON.stringify({
            custom_id: `r${index}`,
            method: 'POST',
            url: '/v1/responses',
            body: job.body,
          })
        )
        .join('\n')

      const form = new FormData()
      form.append('purpose', 'batch')
      form.append('file', new Blob([jsonl], {type: 'application/jsonl'}), 'lexweave-batch.jsonl')
      const file = await api('/files', {method: 'POST', body: form})

      // Batch creation bounces off the per-tier enqueued-token quota while
      // earlier batches are still processing. That is congestion, not failure:
      // wait a minute and try again until a slot frees up (capped ~8h).
      let batch: Record<string, any> | undefined
      for (let attempt = 0; ; attempt += 1) {
        try {
          batch = await api('/batches', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              input_file_id: file.id,
              endpoint: '/v1/responses',
              completion_window: '24h',
            }),
          })
          break
        } catch (error) {
          const status = (error as {status?: number}).status
          const message = error instanceof Error ? error.message : String(error)
          const queueLimited =
            (status === 429 || status === 400 || status == null) &&
            /queue|enqueued|token_limit|rate limit|fetch failed/i.test(message)
          if (!queueLimited || attempt >= 480) {
            throw error
          }
          if (attempt === 0) {
            log(`  [batch-api] queue full, waiting for capacity (${message})`)
          }
          await sleep(60_000)
        }
      }

      log(`  [batch-api] submitted ${jobs.length} requests (${batch.id})`)

      const terminal = new Set(['completed', 'failed', 'expired', 'cancelled'])
      while (!terminal.has(batch.status)) {
        await sleep(pollMs)
        try {
          batch = await api(`/batches/${batch.id}`)
        } catch {
          // Transient poll failure — the batch keeps processing server-side.
        }
      }

      const byId = new Map<string, Record<string, any>>()
      for (const fileId of [batch.output_file_id, batch.error_file_id]) {
        if (!fileId) continue
        const content = await apiText(`/files/${fileId}/content`)
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line)
            if (parsed?.custom_id) byId.set(parsed.custom_id, parsed)
          } catch {
            // Skip unparseable lines; their requests reject as missing below.
          }
        }
      }

      let ok = 0
      jobs.forEach((job, index) => {
        const line = byId.get(`r${index}`)
        if (line?.response?.status_code === 200 && line.response.body) {
          ok += 1
          job.resolve(line.response.body as Record<string, any>)
        } else {
          const detail =
            line?.error?.message ??
            line?.response?.body?.error?.message ??
            (line ? `status ${line.response?.status_code}` : `batch ${batch!.status}, no result`)
          job.reject(new Error(`OpenAI batch request failed: ${detail}`))
        }
      })
      log(`  [batch-api] ${batch.id} ${batch.status}: ${ok}/${jobs.length} ok`)
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      for (const job of jobs) {
        job.reject(wrapped)
      }
    }
  }

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    while (pending.length > 0) {
      void submit(pending.splice(0, maxRequests))
    }
  }

  const schedule = (): void => {
    if (pending.length >= maxRequests) {
      flush()
      return
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        flush()
      }, flushMs)
    }
  }

  return {
    run(body) {
      return new Promise((resolve, reject) => {
        pending.push({body, resolve, reject})
        schedule()
      })
    },
  }
}
