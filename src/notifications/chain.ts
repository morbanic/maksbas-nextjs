import type { ResolvedConfig } from '../config.js'

/** How long we wait for the continuation request to be accepted before letting go. */
const HANDOFF_TIMEOUT_MS = 1000

/**
 * Asks our own drain endpoint to pick up where this invocation left off.
 *
 * The request is deliberately abandoned after a second: we only need the next
 * function instance to have *started*. Waiting for its response would just chain
 * two timeouts together.
 *
 * Returns false when self-chaining isn't possible (no base URL or no cron
 * secret), in which case the cron is the only thing that will finish the send —
 * worth knowing, since on Vercel's Hobby plan that means up to a day.
 */
export async function triggerDrain(config: ResolvedConfig): Promise<boolean> {
  if (!config.selfChain) return false
  if (!config.baseUrl || !config.cronSecret) return false

  const url = `${config.baseUrl}${config.basePath}/cron/drain`

  try {
    await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.cronSecret}` },
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
    })
    return true
  } catch (error) {
    // A timeout here is the expected path, not a failure: the drain is still
    // running on the other side, we just stopped listening.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return true
    }
    console.warn('[maksbas] could not hand off to the drain endpoint:', error)
    return false
  }
}
