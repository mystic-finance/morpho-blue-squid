/**
 * Canton update-stream processor.
 *
 * Mimics the surface of `@subsquid/evm-processor`'s `EvmBatchProcessor` so
 * `src/canton/main.ts` reads like `src/main.ts` — `.run(database, handler)`
 * shape, batched events, ctx.store-backed persistence.
 *
 * What it actually does, in order:
 *   1. Resume from `CantonIndexerState.lastOffset` (or '0' on first boot)
 *   2. Backfill: page through `POST /v2/updates/flats` in bounded chunks
 *      until we reach `GET /v2/state/ledger-end`
 *   3. Tail: poll the same endpoint every `pollIntervalMs` for new events
 *
 * Each batch's entity writes AND the offset update are committed in the
 * same TypeORM transaction so a crash mid-batch replays cleanly.
 *
 * Spike (re-runnable at /Users/0xsammy/morpho-blue-squid/scripts/canton-spike.mjs)
 * validated all the API surfaces this processor depends on:
 *   - JWT auth via FiveNorth client_credentials
 *   - GET /v2/state/ledger-end
 *   - POST /v2/state/active-contracts (used for sanity-check, not by the processor)
 *   - POST /v2/updates/flats with `templateId: "#mystic-lending-base:...:..."`
 */

import { DataSource, EntityManager } from 'typeorm'
import { Store } from '@subsquid/typeorm-store'
import { createOrmConfig } from '@subsquid/typeorm-config'
import { Logger, createLogger } from '@subsquid/logger'
import { CantonAuth, FiveNorthAuth, UnsafeTokenAuth } from './auth'
import { CantonEvent, CantonEventKind } from './payloads'
import { resolveCantonNetwork, templatesForNetwork } from './templates'
import { CantonIndexerState } from '../model'

const INDEXER_STATE_ID = 'canton-indexer'

export interface CantonEndpointConfig {
  /** Base URL, e.g. https://ledger-api.../v2 — trailing /v2 is stripped if present. */
  url: string
  /** Party that observes the contracts we care about. MysticProvider in dev. */
  party: string
}

export interface CantonProcessorBatch {
  events: CantonEvent[]
  /** Largest offset seen in this batch. Stored as the resume cursor. */
  endOffset: string
  /** Latest event time in the batch (epoch microseconds). */
  endTime: bigint
}

export interface CantonHandlerCtx {
  store: Store
  log: Logger
}

export type CantonHandler = (
  ctx: CantonHandlerCtx,
  batch: CantonProcessorBatch,
) => Promise<void>

export interface CantonProcessorOptions {
  endpoint: CantonEndpointConfig
  auth: CantonAuth
  templateFilter: readonly string[]
  /**
   * Row id for this processor's resume cursor in `CantonIndexerState`. Lets a
   * testnet processor keep an offset independent of devnet's. Defaults to
   * `canton-indexer` so the devnet path is byte-for-byte unchanged.
   */
  stateId?: string
  /** Max events per /v2/updates/flats call. Default 200. */
  batchSize?: number
  /** Poll cadence in tail mode, in ms. Default 3000. */
  pollIntervalMs?: number
  /**
   * Max span of ledger offsets fetched per /v2/updates/flats call. Bounds the
   * response size and the per-batch DB transaction during backfill so a large
   * catch-up doesn't load the whole ledger into memory at once. Default 50000.
   */
  offsetWindow?: number
  log?: Logger
}

export class CantonBatchProcessor {
  private readonly base: string
  /** nginx gate secret for the gated public testnet ledger (off-box); unset on-box/devnet. */
  private readonly ledgerKey?: string
  private readonly party: string
  private readonly auth: CantonAuth
  private readonly stateId: string
  private readonly templates: readonly string[]
  private readonly batchSize: number
  private readonly pollIntervalMs: number
  /** Configured cap on the per-call offset span; the ceiling growWindow grows back toward. */
  private readonly maxOffsetWindow: bigint
  /** Current offset span requested per call; shrinks on a too-many-elements rejection, grows back on success. */
  private offsetWindow: bigint
  private readonly log: Logger

  constructor(opts: CantonProcessorOptions) {
    this.base = opts.endpoint.url.replace(/\/v2\/?$/, '')
    this.ledgerKey = process.env.CANTON_TESTNET_LEDGER_HEADER || undefined
    this.party = opts.endpoint.party
    this.auth = opts.auth
    this.stateId = opts.stateId ?? INDEXER_STATE_ID
    this.templates = opts.templateFilter
    this.batchSize = opts.batchSize ?? 200
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000
    this.maxOffsetWindow = BigInt(opts.offsetWindow ?? 50_000)
    this.offsetWindow = this.maxOffsetWindow
    this.log = opts.log ?? createLogger('canton-processor')
  }

  private growWindow(): void {
    if (this.offsetWindow < this.maxOffsetWindow) {
      this.offsetWindow = this.offsetWindow * 2n
      if (this.offsetWindow > this.maxOffsetWindow) this.offsetWindow = this.maxOffsetWindow
    }
  }

  private isTooManyElements(err: any): boolean {
    return String(err?.message ?? err).includes('MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED')
  }

  /**
   * Static factory that pulls everything from environment variables, so
   * `main.ts` can call `CantonBatchProcessor.fromEnv().run(handler)` without
   * threading config plumbing through each layer.
   *
   * `CANTON_NETWORK` (default `devnet`) selects the whole network profile:
   *   - devnet  → `-v3` templates, FiveNorth OAuth, `canton-indexer` state row
   *   - testnet → `-v5` templates, unsafe HS256 auth, `canton-indexer-testnet`
   *
   * `templateOverride` forces a specific template set (tests); when omitted the
   * set is derived from the network so the two processors can never cross wires.
   */
  static fromEnv(templateOverride?: readonly string[]): CantonBatchProcessor {
    const network = resolveCantonNetwork(process.env.CANTON_NETWORK)
    const url = required('CANTON_API_URL')
    const party = required('CANTON_PUBLIC_PARTY')
    const batchSize = Number(process.env.CANTON_INDEXER_BATCH_SIZE ?? 200)
    const pollIntervalMs = Number(process.env.CANTON_INDEXER_POLL_INTERVAL_MS ?? 3000)
    const offsetWindow = Number(process.env.CANTON_INDEXER_OFFSET_WINDOW ?? 50_000)

    const auth: CantonAuth =
      network === 'testnet' ? UnsafeTokenAuth.fromEnv() : FiveNorthAuth.fromEnv()
    const templateFilter = templateOverride ?? templatesForNetwork(network)
    const stateId = network === 'testnet' ? `${INDEXER_STATE_ID}-testnet` : INDEXER_STATE_ID

    return new CantonBatchProcessor({
      endpoint: { url, party },
      auth,
      templateFilter,
      stateId,
      batchSize,
      pollIntervalMs,
      offsetWindow,
    })
  }

  async run(handler: CantonHandler): Promise<void> {
    this.log.info(
      `canton processor starting — state=${this.stateId}, party=${this.party}, ` +
      `templates: ${this.templates.join(', ')}`,
    )

    // Bootstrap a TypeORM DataSource using the same env-driven connection
    // config @subsquid/typeorm-store uses for the EVM processors. That keeps
    // the DB_HOST/DB_PORT/DB_NAME/etc conventions consistent across networks.
    const ormConfig = createOrmConfig({ projectDir: process.cwd() })
    const dataSource = new DataSource(ormConfig)
    await dataSource.initialize()
    this.log.info(`db connected: ${ormConfig.database}@${(ormConfig as any).host ?? '(url)'}`)

    try {
      let lastOffset = await this.resumeFromDb(dataSource)
      this.log.info(`resume offset = ${lastOffset || '(genesis)'}`)

      // Phase A: backfill until caught up. Ledger end is re-checked every
      // iteration so a tx landing mid-backfill extends the target.
      //
      // The whole body is guarded: a transient failure (ledger blip, DB hiccup)
      // must NOT escape to main.ts's `process.exit(1)`. We log, back off, and
      // retry from the same lastOffset — offsets only persist on success, so a
      // retry replays cleanly.
      let backfillBackoffMs = 1_000
      while (true) {
        try {
          const ledgerEnd = await this.getLedgerEndWithRetry()
          if (compareOffsets(lastOffset, ledgerEnd) >= 0) {
            this.log.info(`caught up at offset ${ledgerEnd}; switching to poll mode`)
            break
          }
          // Bound this batch to an offset window so a large catch-up doesn't
          // pull the whole ledger into one response / one DB transaction. The
          // node also caps a response at `batchSize` matching elements and
          // rejects (413) rather than truncating, so on a too-dense range we
          // halve the window and retry, growing it back once past the stretch.
          const windowEnd = minOffset(addOffset(lastOffset, this.offsetWindow), ledgerEnd)
          let batchEnd: string | null
          try {
            batchEnd = await this.runOneBatch(dataSource, handler, lastOffset, windowEnd)
          } catch (err: any) {
            if (this.isTooManyElements(err) && this.offsetWindow > 1n) {
              this.offsetWindow = this.offsetWindow / 2n
              this.log.warn(`range too dense; halving window to ${this.offsetWindow}`)
              continue
            }
            throw err
          }
          this.growWindow()
          if (batchEnd === null) {
            // No events in the requested window — advance past it so we don't
            // loop forever re-querying the same range.
            lastOffset = windowEnd
            await this.persistOffsetOnly(dataSource, lastOffset)
          } else {
            lastOffset = batchEnd
          }
          backfillBackoffMs = 1_000
        } catch (err: any) {
          this.log.warn(`backfill iteration failed (will retry): ${err?.message ?? err}`)
          await sleep(backfillBackoffMs)
          backfillBackoffMs = Math.min(backfillBackoffMs * 2, 30_000)
        }
      }

      // Phase B: tail. Same call, looped with sleep + ledger-end refresh.
      while (true) {
        try {
          const ledgerEnd = await this.getLedgerEndWithRetry()
          if (compareOffsets(lastOffset, ledgerEnd) < 0) {
            // Window the tail too: if the indexer fell far behind, the first
            // poll could otherwise span a huge range.
            const windowEnd = minOffset(addOffset(lastOffset, this.offsetWindow), ledgerEnd)
            const batchEnd = await this.runOneBatch(dataSource, handler, lastOffset, windowEnd)
            if (batchEnd === null) {
              lastOffset = windowEnd
              await this.persistOffsetOnly(dataSource, lastOffset)
            } else {
              lastOffset = batchEnd
            }
            // Skip the sleep when we still have ground to cover — keep draining.
            if (compareOffsets(lastOffset, ledgerEnd) < 0) continue
          }
        } catch (err: any) {
          this.log.warn(`tail iteration failed: ${err?.message ?? err}`)
        }
        await sleep(this.pollIntervalMs)
      }
    } finally {
      // Unreachable under normal operation (tail loop is infinite) but
      // releases the connection cleanly on SIGTERM / uncaught throw.
      await dataSource.destroy().catch(() => undefined)
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  private async resumeFromDb(dataSource: DataSource): Promise<string> {
    let offset = '0'
    await this.withStore(dataSource, async (store) => {
      const row = await store.get(CantonIndexerState, this.stateId)
      if (row?.lastOffset) offset = row.lastOffset
    })
    return offset
  }

  /** Run one batch: fetch events, hand to user, persist offset atomically. */
  private async runOneBatch(
    dataSource: DataSource,
    handler: CantonHandler,
    beginExclusive: string,
    endInclusive: string,
  ): Promise<string | null> {
    const updates = await this.fetchUpdatesWithRetry(beginExclusive, endInclusive)
    if (updates.length === 0) return null

    // Flatten the wrapped Transaction events into a flat CantonEvent[].
    const events: CantonEvent[] = []
    let endOffset = beginExclusive
    let endTime = 0n
    for (const u of updates) {
      const tx = u?.update?.Transaction?.value
      if (!tx) continue
      const recordTime = parseIsoToBigint(tx.effectiveAt)
      const txEvents = Array.isArray(tx.events) ? tx.events : []
      for (const e of txEvents) {
        const created = e?.CreatedEvent
        const archived = e?.ArchivedEvent
        if (created) {
          events.push({
            offset: String(created.offset),
            recordTime,
            transactionId: tx.updateId,
            templateId: created.templateId,
            contractId: created.contractId,
            kind: 'created',
            payload: created.createArgument ?? null,
            // Raw disclosed-contract blob; populated because the stream filter
            // sets includeCreatedEventBlob. Persisted so the squid can be the
            // disclosure source for the off-ledger liquidator.
            createdEventBlob: created.createdEventBlob ?? null,
          })
        } else if (archived) {
          events.push({
            offset: String(archived.offset),
            recordTime,
            transactionId: tx.updateId,
            templateId: archived.templateId,
            contractId: archived.contractId,
            kind: 'archived',
            payload: null,
          })
        }
      }
      const lastEvent = txEvents[txEvents.length - 1]
      const offsetForTx = String(
        lastEvent?.CreatedEvent?.offset ??
        lastEvent?.ArchivedEvent?.offset ??
        endOffset,
      )
      if (compareOffsets(offsetForTx, endOffset) > 0) endOffset = offsetForTx
      if (recordTime > endTime) endTime = recordTime
    }

    this.log.info(
      `batch [${beginExclusive} → ${endOffset}] ${events.length} event(s) in ${updates.length} tx`,
    )

    // Hand the batch to the handler inside a transaction. Persist the
    // offset row in the SAME transaction so a crash mid-handler replays
    // from the previous batch's end, not from a half-applied state.
    await this.withStore(dataSource, async (store) => {
      await handler({ store, log: this.log }, { events, endOffset, endTime })
      await store.upsert(
        new CantonIndexerState({
          id: this.stateId,
          lastOffset: endOffset,
          lastEventTime: endTime,
          // Approximate per-batch count. Exact totals derive from event tables.
          eventsProcessed: BigInt(events.length),
          updatedAt: BigInt(Math.floor(epochSeconds())),
        }),
      )
    })

    return endOffset
  }

  /** Persist the offset alone when no events fell into a queried range. */
  private async persistOffsetOnly(dataSource: DataSource, offset: string): Promise<void> {
    await this.withStore(dataSource, async (store) => {
      await store.upsert(
        new CantonIndexerState({
          id: this.stateId,
          lastOffset: offset,
          lastEventTime: 0n,
          eventsProcessed: 0n,
          updatedAt: BigInt(Math.floor(epochSeconds())),
        }),
      )
    })
  }

  /** Open a TypeORM transaction, hand the caller a `Store` over its EM. */
  private async withStore(
    dataSource: DataSource,
    cb: (store: Store) => Promise<void>,
  ): Promise<void> {
    await dataSource.transaction(async (em: EntityManager) => {
      const store = new Store(() => em)
      await cb(store)
    })
  }

  private async getLedgerEnd(): Promise<string> {
    const r = await this.authedFetch(`${this.base}/v2/state/ledger-end`)
    if (r.status === 401 || r.status === 403) {
      // Token may have expired — refresh once and let the caller retry.
      await this.auth.forceRefresh()
      throw new Error(`ledger-end ${r.status} (token refreshed)`)
    }
    if (!r.ok) {
      throw new Error(`ledger-end ${r.status}: ${(await r.text()).slice(0, 200)}`)
    }
    const j = (await r.json()) as { offset: string | number }
    return String(j.offset)
  }

  /** ledger-end with brief exponential backoff, so a transient blip doesn't
   *  bubble up to a process exit during backfill. */
  private async getLedgerEndWithRetry(): Promise<string> {
    let backoffMs = 1_000
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await this.getLedgerEnd()
      } catch (err: any) {
        if (attempt === 5) throw err
        this.log.warn(`ledger-end error (attempt ${attempt + 1}/6): ${err?.message ?? err}`)
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    }
    // Unreachable — the loop either returns or throws on the final attempt.
    throw new Error('ledger-end: exhausted retries')
  }

  /** Wrapped /v2/updates/flats POST with 401-refresh-once and brief retry. */
  private async fetchUpdatesWithRetry(
    beginExclusive: string,
    endInclusive: string,
  ): Promise<any[]> {
    let backoffMs = 1_000
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await this.fetchUpdates(beginExclusive, endInclusive)
        if (r.ok) {
          const text = await r.text()
          if (!text) return []
          // Endpoint returns a JSON array; some versions ndjson. Try array first.
          if (text.startsWith('[')) return JSON.parse(text)
          return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
        }
        if (r.status === 401 || r.status === 403) {
          this.log.warn(`auth error ${r.status} — forcing token refresh`)
          await this.auth.forceRefresh()
          continue  // retry immediately with fresh token
        }
        const body = await r.text().catch(() => '')
        throw new Error(`/v2/updates/flats ${r.status}: ${body.slice(0, 300)}`)
      } catch (err: any) {
        // Retrying an over-dense range just repeats the rejection; surface it so
        // the caller can shrink the window.
        if (this.isTooManyElements(err)) throw err
        if (attempt === 5) throw err
        this.log.warn(`fetch error (attempt ${attempt + 1}/6): ${err?.message ?? err}`)
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    }
    return []
  }

  private async fetchUpdates(
    beginExclusive: string,
    endInclusive: string,
  ): Promise<Response> {
    return this.authedFetch(`${this.base}/v2/updates/flats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        beginExclusive,
        endInclusive,
        filter: {
          filtersByParty: {
            [this.party]: {
              cumulative: this.templates.map((tid) => ({
                identifierFilter: {
                  TemplateFilter: {
                    value: { templateId: tid, includeCreatedEventBlob: true },
                  },
                },
              })),
            },
          },
        },
        verbose: false,
      }),
    })
  }

  private async authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const jwt = await this.auth.getAccessToken()
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${jwt}`,
      ...(this.ledgerKey ? { 'X-Ledger-Key': this.ledgerKey } : {}),
    }
    return fetch(url, { ...init, headers })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function toOffsetBigInt(s: string): bigint {
  // Canton offsets are numeric strings (the spike showed `1958039`). Guard the
  // parse so an unexpected non-numeric value can't throw and crash the loop.
  try {
    return BigInt(s || '0')
  } catch {
    return 0n
  }
}

function compareOffsets(a: string, b: string): number {
  // Compare as BigInt to handle arbitrarily large values without precision loss.
  const ba = toOffsetBigInt(a)
  const bb = toOffsetBigInt(b)
  return ba < bb ? -1 : ba > bb ? 1 : 0
}

/** lastOffset + window, as a string offset. */
function addOffset(a: string, window: bigint): string {
  return String(toOffsetBigInt(a) + window)
}

/** The smaller of two string offsets. */
function minOffset(a: string, b: string): string {
  return compareOffsets(a, b) <= 0 ? a : b
}

function parseIsoToBigint(iso: string): bigint {
  // recordTime stored as Unix-epoch microseconds in BigInt — matches DAML's
  // native Time precision (Numeric 10 microseconds). Guard against a
  // missing/invalid effectiveAt: `BigInt(NaN)` throws, which would otherwise
  // crash the (unguarded-per-event) batch. Fall back to 0n.
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 0n
  return BigInt(ms) * 1000n
}

function epochSeconds(): number {
  return Date.now() / 1000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

// Re-export so handlers can import CantonEvent etc. from the processor.
export { CantonEvent, CantonEventKind }
