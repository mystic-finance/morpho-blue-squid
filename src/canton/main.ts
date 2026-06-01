/**
 * Canton indexer entry point.
 *
 * Subscribes to `MysticMarket.Market` create/archive events via the Canton
 * update-stream processor, persists lineage + market state + snapshots into
 * Postgres. The GraphQL server (squid-graphql-server, run separately by the
 * `serve:canton` command) reads the same tables.
 *
 * Routed to from `src/main.ts` when `NETWORK=CANTON`; see Phase 4.
 *
 * Mode A scope: Market events only. Position/LendingPosition handlers are
 * stubbed for Mode B (portfolio queries).
 */

import { Store } from '@subsquid/typeorm-store'
import { createLogger } from '@subsquid/logger'
import { CantonBatchProcessor, CantonProcessorBatch, CantonHandlerCtx } from './processor'
import { MODE_A_TEMPLATES, TEMPLATE_MARKET } from './templates'
import { CantonEvent, MarketPayload, isMarketEvent } from './payloads'
import {
  CantonMarket,
  CantonMarketLineage,
  CantonMarketDailySnapshot,
  CantonMarketHourlySnapshot,
} from '../model'
import {
  getOrCreateCantonToken,
  num10ToBigInt,
  computeBorrowAPY,
  computeSupplyAPY,
  microsToSeconds,
  dayIdOf,
  hourIdOf,
} from './helpers'

const log = createLogger('canton-main')

export async function start(): Promise<void> {
  log.info('canton indexer booting')
  const processor = CantonBatchProcessor.fromEnv(MODE_A_TEMPLATES)
  await processor.run(handleBatch)
}

// ────────────────────────────────────────────────────────────────────────
// Batch dispatch
// ────────────────────────────────────────────────────────────────────────

async function handleBatch(ctx: CantonHandlerCtx, batch: CantonProcessorBatch): Promise<void> {
  for (const evt of batch.events) {
    if (isMarketEvent(evt)) {
      if (evt.kind === 'created') {
        await onMarketCreated(ctx, evt as CantonEvent<MarketPayload>)
      } else {
        await onMarketArchived(ctx, evt)
      }
    }
    // Mode B: dispatch Position / LendingPosition events here.
    // if (isPositionEvent(evt)) await onPositionEvent(ctx, evt)
    // if (isLendingPositionEvent(evt)) await onLendingPositionEvent(ctx, evt)
  }
}

// ────────────────────────────────────────────────────────────────────────
// Market event handlers
// ────────────────────────────────────────────────────────────────────────

async function onMarketCreated(
  { store, log }: CantonHandlerCtx,
  evt: CantonEvent<MarketPayload>,
): Promise<void> {
  const payload = evt.payload
  if (!payload) {
    log.warn(`Market create event without payload at offset ${evt.offset}; skipping`)
    return
  }

  const oracle = payload.params.oracle
  if (!oracle) {
    log.warn(`Market create at offset ${evt.offset} has empty params.oracle; skipping`)
    return
  }

  // Tokens — get-or-create. The first time a market appears, the loan and
  // collateral tokens are recorded so they can be joined in GraphQL.
  const loanToken = await getOrCreateCantonToken(store, payload.params.loanInstrument)
  const collateralToken = await getOrCreateCantonToken(store, payload.params.collateralInstrument)

  // CantonMarket — keyed by oracle (churn-stable). Upserts in place, the
  // most recently seen create's totals + IRM win.
  const existing = await store.get(CantonMarket, oracle)
  const market = existing ?? new CantonMarket({ id: oracle, loanToken, collateralToken } as any)
  market.currentContractId = evt.contractId
  market.loanToken = loanToken
  market.collateralToken = collateralToken
  market.irm = payload.irm?.currentRate ? `rate=${payload.irm.currentRate}` : ''
  market.lltv = num10ToBigInt(payload.params.lltv)
  market.liquidationThreshold = num10ToBigInt(payload.params.liquidationThreshold)
  market.fee = num10ToBigInt(payload.params.fee)
  market.totalSupplyAssets = num10ToBigInt(payload.totalSupplyAssets)
  market.totalSupplyShares = num10ToBigInt(payload.totalSupplyShares)
  market.totalBorrowAssets = num10ToBigInt(payload.totalBorrowAssets)
  market.totalBorrowShares = num10ToBigInt(payload.totalBorrowShares)
  market.borrowAPY = computeBorrowAPY(payload.irm?.currentRate)
  market.supplyAPY = computeSupplyAPY(
    payload.irm?.currentRate,
    payload.totalSupplyAssets,
    payload.totalBorrowAssets,
    payload.params.fee,
  )
  market.lastUpdate = evt.recordTime
  await store.upsert(market)

  // CantonMarketLineage — append-only. Resolves stale cids in FE URLs.
  const lineageId = evt.contractId
  const lineageRow = await store.get(CantonMarketLineage, lineageId)
  if (lineageRow) {
    lineageRow.lastSeen = evt.recordTime
    await store.upsert(lineageRow)
  } else {
    await store.upsert(
      new CantonMarketLineage({
        id: lineageId,
        market,
        firstSeen: evt.recordTime,
        lastSeen: evt.recordTime,
      }),
    )
  }

  // Snapshots.
  await updateSnapshots(store, market, evt.recordTime)
}

async function onMarketArchived(
  { store }: CantonHandlerCtx,
  evt: CantonEvent,
): Promise<void> {
  // Mark the lineage row as archived. We don't touch CantonMarket — the
  // next create with the same marketKey will overwrite currentContractId.
  const lineageRow = await store.get(CantonMarketLineage, evt.contractId)
  if (lineageRow && lineageRow.archivedAt == null) {
    lineageRow.archivedAt = evt.recordTime
    lineageRow.lastSeen = evt.recordTime
    await store.upsert(lineageRow)
  }
}

// ────────────────────────────────────────────────────────────────────────
// Snapshot bucketing
// ────────────────────────────────────────────────────────────────────────

async function updateSnapshots(
  store: Store,
  market: CantonMarket,
  recordTime: bigint,
): Promise<void> {
  const epochSec = microsToSeconds(recordTime)
  const dayId = dayIdOf(epochSec)
  const hourId = hourIdOf(epochSec)
  const tsBig = BigInt(epochSec)

  // Daily.
  const dailyId = `${market.id}-${dayId}`
  const daily =
    (await store.get(CantonMarketDailySnapshot, dailyId)) ??
    new CantonMarketDailySnapshot({ id: dailyId, market, dayId } as any)
  daily.market = market
  daily.dayId = dayId
  daily.timestamp = tsBig
  daily.totalSupplyAssets = market.totalSupplyAssets
  daily.totalSupplyShares = market.totalSupplyShares
  daily.totalBorrowAssets = market.totalBorrowAssets
  daily.totalBorrowShares = market.totalBorrowShares
  daily.borrowAPY = market.borrowAPY
  daily.supplyAPY = market.supplyAPY
  await store.upsert(daily)

  // Hourly.
  const hourlyId = `${market.id}-${hourId}`
  const hourly =
    (await store.get(CantonMarketHourlySnapshot, hourlyId)) ??
    new CantonMarketHourlySnapshot({ id: hourlyId, market, hourId } as any)
  hourly.market = market
  hourly.hourId = hourId
  hourly.timestamp = tsBig
  hourly.totalSupplyAssets = market.totalSupplyAssets
  hourly.totalSupplyShares = market.totalSupplyShares
  hourly.totalBorrowAssets = market.totalBorrowAssets
  hourly.totalBorrowShares = market.totalBorrowShares
  hourly.borrowAPY = market.borrowAPY
  hourly.supplyAPY = market.supplyAPY
  await store.upsert(hourly)
}

// Allow `node lib/canton/main.js` direct entry (used by docker-compose
// processor_canton service). When invoked via src/main.ts network guard,
// this branch is no-op because main.ts already calls start().
if (require.main === module) {
  start().catch((err) => {
    log.fatal(err, 'canton indexer crashed')
    process.exit(1)
  })
}
