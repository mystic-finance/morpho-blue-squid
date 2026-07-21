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
import { MODE_B_TEMPLATES } from './templates'
import {
  CantonEvent,
  MarketPayload,
  PositionPayload,
  MockOraclePayload,
  ChainlinkOraclePayload,
  isMarketEvent,
  isPositionEvent,
  isMockOracleEvent,
  isChainlinkOracleEvent,
} from './payloads'
import {
  CantonMarket,
  CantonOracle,
  CantonMarketLineage,
  CantonMarketDailySnapshot,
  CantonMarketHourlySnapshot,
  CantonPosition,
  CantonPositionLineage,
} from '../model'
import {
  getOrCreateCantonToken,
  num10ToBigInt,
  computeBorrowAPY,
  computeSupplyAPY,
  microsToSeconds,
  dayIdOf,
  hourIdOf,
  oracleKeyOf,
} from './helpers'

const log = createLogger('canton-main')

export async function start(): Promise<void> {
  log.info('canton indexer booting')
  const processor = CantonBatchProcessor.fromEnv(MODE_B_TEMPLATES)
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
    } else if (isPositionEvent(evt)) {
      if (evt.kind === 'created') {
        await onPositionCreated(ctx, evt as CantonEvent<PositionPayload>)
      } else {
        await onPositionArchived(ctx, evt)
      }
    } else if (isMockOracleEvent(evt) && evt.kind === 'created') {
      const p = (evt as CantonEvent<MockOraclePayload>).payload
      if (p) {
        await onOraclePrice(
          ctx,
          oracleKeyOf(p.provider, p.baseAsset, p.quoteAsset),
          p.cachedPrice?.price,
          evt.recordTime,
        )
      }
    } else if (isChainlinkOracleEvent(evt) && evt.kind === 'created') {
      const p = (evt as CantonEvent<ChainlinkOraclePayload>).payload
      if (p) {
        await onOraclePrice(
          ctx,
          oracleKeyOf(p.provider, p.baseAsset, p.quoteAsset),
          p.cachedPrice?.price,
          evt.recordTime,
        )
      }
    }
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

  const marketId = payload.marketId
  if (!marketId) {
    log.warn(`Market create at offset ${evt.offset} has empty marketId; skipping`)
    return
  }
  const oracleKey = oracleKeyOf(
    payload.params.oracleProvider,
    payload.params.collateralToken,
    payload.params.loanToken,
  )

  // Tokens — get-or-create. The first time a market appears, the loan and
  // collateral tokens are recorded so they can be joined in GraphQL.
  const loanToken = await getOrCreateCantonToken(store, payload.params.loanInstrument)
  const collateralToken = await getOrCreateCantonToken(store, payload.params.collateralInstrument)

  // Keyed by marketId — params.oracle is frozen and shared across markets, so it collides.
  const existing = await store.get(CantonMarket, marketId)
  const market = existing ?? new CantonMarket({ id: marketId, loanToken, collateralToken } as any)
  market.marketId = marketId
  market.oracleKey = oracleKey
  market.paramsOracle = payload.params.oracle ?? ''
  market.marketCid = evt.contractId
  market.loanToken = loanToken
  market.collateralToken = collateralToken
  market.irm = payload.irm?.currentRate ? `rate=${payload.irm.currentRate}` : ''
  market.lltv = num10ToBigInt(payload.params.lltv)
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
  // Apply any price recorded under this oracle before the market existed.
  const oracleRow = await store.get(CantonOracle, oracleKey)
  if (oracleRow?.price != null) {
    market.oraclePrice = oracleRow.price
    market.priceUpdatedAt = oracleRow.priceUpdatedAt
  }
  await store.upsert(market)

  // The debt ratio (totalBorrowAssets/Shares) moved → re-evaluate this market's positions.
  await recomputeMarketPositions(store, market, evt.recordTime)

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
  // next create with the same marketId will overwrite marketCid.
  const lineageRow = await store.get(CantonMarketLineage, evt.contractId)
  if (lineageRow && lineageRow.archivedAt == null) {
    lineageRow.archivedAt = evt.recordTime
    lineageRow.lastSeen = evt.recordTime
    await store.upsert(lineageRow)
  }
}

// ────────────────────────────────────────────────────────────────────────
// Position events + liquidation health
// ────────────────────────────────────────────────────────────────────────

async function onPositionCreated(
  { store, log }: CantonHandlerCtx,
  evt: CantonEvent<PositionPayload>,
): Promise<void> {
  const payload = evt.payload
  if (!payload) {
    log.warn(`Position create without payload at offset ${evt.offset}; skipping`)
    return
  }
  const oracle = payload.oracle
  if (!oracle) {
    log.warn(`Position create at offset ${evt.offset} has empty oracle; skipping`)
    return
  }

  const id = `${oracle}-${payload.owner}`
  // Position carries no marketId, so join on the frozen params.oracle. Undefined if not yet indexed.
  const market = await store.findOne(CantonMarket, { where: { paramsOracle: oracle } })

  const pos = (await store.get(CantonPosition, id)) ?? new CantonPosition({ id } as any)
  pos.currentContractId = evt.contractId
  pos.marketId = market?.marketId ?? ''
  pos.owner = payload.owner
  pos.provider = payload.provider
  pos.collateralAmount = num10ToBigInt(payload.collateralAmount)
  pos.borrowShares = num10ToBigInt(payload.borrowShares)
  pos.lltv = num10ToBigInt(payload.lltv)
  pos.lastUpdate = evt.recordTime
  if (market) {
    pos.market = market
    applyHealth(pos, market)
  } else {
    // Market not seen yet; default safe. Recomputed when the market arrives.
    pos.borrowAssets = 0n
    pos.liquidatable = false
  }
  await store.upsert(pos)

  const lineageRow = await store.get(CantonPositionLineage, evt.contractId)
  if (lineageRow) {
    lineageRow.lastSeen = evt.recordTime
    await store.upsert(lineageRow)
  } else {
    await store.upsert(
      new CantonPositionLineage({
        id: evt.contractId,
        position: pos,
        firstSeen: evt.recordTime,
        lastSeen: evt.recordTime,
      }),
    )
  }
}

async function onPositionArchived({ store }: CantonHandlerCtx, evt: CantonEvent): Promise<void> {
  const lineageRow = await store.get(CantonPositionLineage, evt.contractId)
  if (lineageRow && lineageRow.archivedAt == null) {
    lineageRow.archivedAt = evt.recordTime
    lineageRow.lastSeen = evt.recordTime
    await store.upsert(lineageRow)
  }
}

// Record an oracle price and fan it out to every market on that pair.
async function onOraclePrice(
  { store }: CantonHandlerCtx,
  oracleKey: string,
  price: string | undefined | null,
  recordTime: bigint,
): Promise<void> {
  if (!price) return
  const priceScaled = num10ToBigInt(price)
  // Keyed by identity, not cid, so it survives churn and a later-indexed market reads it back.
  await store.upsert(new CantonOracle({ id: oracleKey, price: priceScaled, priceUpdatedAt: recordTime }))
  // One oracle backs every market on its pair.
  const markets = await store.find(CantonMarket, { where: { oracleKey } } as any)
  for (const market of markets) {
    market.oraclePrice = priceScaled
    market.priceUpdatedAt = recordTime
    await store.upsert(market)
    await recomputeMarketPositions(store, market, recordTime)
  }
}

// Re-evaluate liquidatable for every position in a market (debt ratio or price moved).
async function recomputeMarketPositions(
  store: Store,
  market: CantonMarket,
  _recordTime: bigint,
): Promise<void> {
  const positions = await store.find(CantonPosition, {
    where: { market: { id: market.id } },
  } as any)
  for (const pos of positions) {
    pos.market = market
    applyHealth(pos, market)
    await store.upsert(pos)
  }
}

// debt = borrowShares * totalBorrowAssets / totalBorrowShares (all 1e10-scaled).
// liquidatable iff debt > collateral * price * lltv, compared exactly in bigint:
//   borrowAssets[1e10] * 1e20  >  collateral[1e10] * price[1e10] * lltv[1e10].
function applyHealth(pos: CantonPosition, market: CantonMarket): void {
  const tbs = market.totalBorrowShares
  pos.borrowAssets = tbs > 0n ? (pos.borrowShares * market.totalBorrowAssets) / tbs : 0n
  const price = market.oraclePrice
  if (price == null || price <= 0n) {
    pos.liquidatable = false
    return
  }
  pos.liquidatable = pos.borrowAssets * 10n ** 20n > pos.collateralAmount * price * pos.lltv
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
