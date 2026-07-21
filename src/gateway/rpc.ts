/**
 * Minimal JSON-RPC reader for live ERC20 `balanceOf` lookups.
 *
 * The gateway is otherwise read-only over Postgres, but a wallet's plain token
 * balance is not derivable from indexed Morpho events — it changes on transfers
 * the indexer never sees. Rather than index every ERC20 Transfer, we read the
 * balance at query time straight from the chain's JSON-RPC endpoint.
 *
 * No web3 library: a hand-built `balanceOf(address)` calldata and a batched
 * `eth_call` are all this needs, and pulling in viem/ethers for one selector
 * would be the only heavyweight dependency in the gateway.
 */
import { ChainConfig } from './config'

/** keccak256("balanceOf(address)")[:4]. */
const BALANCE_OF_SELECTOR = '0x70a08231'

/** Cap per JSON-RPC batch so a large page doesn't build a multi-MB request. */
const MAX_BATCH = Number(process.env.GATEWAY_RPC_BATCH ?? 100)

/** A (token, account) pair to read, keyed so callers can match results back. */
export interface BalanceQuery {
    key: string
    token: string
    account: string
}

function callData(account: string): string {
    const addr = account.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    return BALANCE_OF_SELECTOR + addr
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
}

/**
 * Read balances for many (token, account) pairs in as few round trips as
 * possible. A chain with no `rpc` configured, or an endpoint that errors,
 * yields no entries for the affected pairs — the caller then reports the
 * holding as null rather than a wrong zero.
 */
export async function readBalances(chain: ChainConfig, queries: BalanceQuery[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>()
    const url = chain.rpc
    if (!url || queries.length === 0) return out

    for (const batch of chunk(queries, MAX_BATCH)) {
        const body = batch.map((q, i) => ({
            jsonrpc: '2.0',
            id: i,
            method: 'eth_call',
            params: [{ to: q.token, data: callData(q.account) }, 'latest'],
        }))

        let json: any
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(Number(process.env.GATEWAY_RPC_TIMEOUT_MS ?? 8000)),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            json = await res.json()
        } catch (err: any) {
            console.warn(`[gateway] ${chain.key}: balanceOf RPC batch failed — ${err.message}`)
            continue
        }

        // A JSON-RPC batch response is an array, but its order is not
        // guaranteed — match each result back to its request by id.
        const rows: any[] = Array.isArray(json) ? json : [json]
        for (const row of rows) {
            const q = batch[row?.id]
            if (!q) continue
            const hex = row?.result
            if (typeof hex !== 'string' || hex === '0x' || row.error) continue
            try {
                out.set(q.key, BigInt(hex))
            } catch {
                // non-hex result (reverted call returning garbage) — skip
            }
        }
    }

    return out
}
