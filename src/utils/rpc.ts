/**
 * RPC resilience helpers.
 *
 * Subsquid's RpcClient already retries *connection* errors forever
 * (retryAttempts = MAX_SAFE_INTEGER): HTTP 429/502/503/504, socket timeouts,
 * and RpcErrors whose message matches /rate limit/ or /timed out/. But many
 * providers signal transient overload differently — HTTP 500, or JSON-RPC
 * errors like `{code:-32005,"message":"limit exceeded"}` / "Too Many Requests"
 * — and those are NOT retried by the client; they throw straight through.
 *
 * Because the squid runner has no retry around the user handler, an unhandled
 * throw there ends the process (`process.exit(1)`). These helpers give us an
 * in-handler "wait and try again" for idempotent contract reads so a transient
 * blip degrades gracefully instead of killing the indexer.
 */

/**
 * Heuristic: does this error look like a transient transport/overload problem
 * (worth retrying) rather than a deterministic failure like a revert or a
 * decode error (retrying won't help)?
 */
export function isTransientRpcError(err: any): boolean {
    if (err == null) return false
    const name = String(err.name ?? '')
    if (
        name === 'RpcConnectionError' ||
        name === 'HttpTimeoutError' ||
        name === 'HttpConnectionError' ||
        name === 'RetryError'
    ) {
        return true
    }
    const status = err.status ?? err.response?.status ?? err.statusCode
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
        return true
    }
    const msg = String(err.message ?? err).toLowerCase()
    return /timeout|timed out|rate limit|too many requests|limit exceeded|capacity|throttl|econnreset|etimedout|econnrefused|socket hang up|fetch failed|network|enotfound|eai_again|service unavailable|bad gateway|gateway timeout|connection (reset|closed|terminated)/.test(
        msg,
    )
}

/**
 * Retry an idempotent async RPC read on transient errors with exponential
 * backoff. Deterministic errors (reverts, decode failures) are re-thrown
 * immediately so callers can treat them as a real "not applicable" signal.
 *
 * Note the ceiling: when the attempts are exhausted the last error is
 * re-thrown, and in a core-event path that reaches the runner and ends the
 * process. That is deliberate — see the fatal-error note at the run() call in
 * main.ts — but it means these defaults decide how long a provider blip has to
 * last before it takes the indexer down. Tune with RPC_RETRY_ATTEMPTS /
 * RPC_RETRY_BASE_DELAY_MS / RPC_RETRY_MAX_DELAY_MS. The defaults below span
 * roughly 3 minutes of retrying before giving up.
 *
 * No amount of retrying survives a provider whose *monthly quota* is spent —
 * that returns the same transient-looking rate-limit error indefinitely.
 */
export async function withRpcRetry<T>(
    fn: () => Promise<T>,
    opts: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
    const attempts = opts.attempts ?? Number(process.env.RPC_RETRY_ATTEMPTS ?? 8)
    const baseDelayMs = opts.baseDelayMs ?? Number(process.env.RPC_RETRY_BASE_DELAY_MS ?? 500)
    const maxDelayMs = opts.maxDelayMs ?? Number(process.env.RPC_RETRY_MAX_DELAY_MS ?? 30_000)

    let lastErr: any
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn()
        } catch (err) {
            lastErr = err
            // Deterministic failure — retrying is pointless.
            if (!isTransientRpcError(err)) throw err
            if (i === attempts - 1) break
            const delay = Math.min(baseDelayMs * 2 ** i, maxDelayMs)
            await new Promise((r) => setTimeout(r, delay))
        }
    }
    throw lastErr
}
