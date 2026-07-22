import { TypeormDatabase } from '@subsquid/typeorm-store'
console.log('[main] Entry point reached. Importing dependencies...');
import { dataSource, processor, USE_PORTAL, MORPHO_BLUE, PUBLIC_ALLOCATOR } from './processor'
import { run } from '@subsquid/batch-processor'
import { augmentBlock } from '@subsquid/evm-objects'
import { createLogger } from '@subsquid/logger'
import { RpcClient } from '@subsquid/rpc-client'
import * as morphoBlue from './abi/MorphoBlue'
import * as metaMorpho from './abi/MetaMorpho'
import * as publicAllocatorAbi from './abi/PublicAllocator'
import * as erc20Abi from './abi/ERC20'
import {
    LendingProtocol, Market, Token, Account, Position, InterestRate,
    Deposit, Withdraw, Borrow, Repay, Liquidate,
    MetaMorpho as MetaMorphoEntity, MetaMorphoPosition, MetaMorphoDeposit, MetaMorphoWithdraw,
    MetaMorphoMarketAllocation, MetaMorphoMarketWithdrawAllocation,
    PositionSide, InterestRateSide, InterestRateType,
    MarketDailySnapshot, MarketHourlySnapshot,
    MetaMorphoDailySnapshot, MetaMorphoHourlySnapshot,
    PublicAllocatorFlowCap,
} from './model'
import { DataHandlerContext, BlockHeader, assertNotNull } from '@subsquid/evm-processor'
import { Store } from '@subsquid/typeorm-store'
import { In, MoreThan } from 'typeorm'
import * as vaultV2Abi from './abi/VaultV2'
import {
    VaultV2, VaultV2Position, VaultV2Deposit, VaultV2Withdraw, VaultV2Allocation,
    VaultV2DailySnapshot, VaultV2HourlySnapshot,
} from './model'
import {
    getTokenPriceInUsd, calcUSD, getMarketOraclePrice, collateralPriceFromOracle,
    persistTokenPrice, hasDirectPriceSource, isUsdDenominated,
} from './utils/prices'
import { withRpcRetry, isTransientRpcError } from './utils/rpc'
import { liquidationPenaltyFromLltv, lltvToFraction } from './utils/morphoMath'


// EvmBatchProcessor used to own both the logger and the RPC connection that
// backed contract state reads. The portal data source owns neither, so the
// mapping supplies them. Built lazily-ish at module scope: Canton never
// reaches the run() call below, and RpcClient does not connect on construction.
const mappingLogger = createLogger('sqd:processor:mapping')

const rpcClient = new RpcClient({
    url: assertNotNull(process.env.RPC_ENDPOINT, 'RPC_ENDPOINT is required'),
    rateLimit: Number(process.env.RPC_RATE_LIMIT ?? 100),
    capacity: Number(process.env.RPC_CAPACITY ?? 100),
    requestTimeout: 60000,
})

const PROTOCOL_ID = 'morpho-blue'
const NETWORK = process.env.NETWORK ?? 'UNKNOWN'


// Time constants
const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = 86400
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY
const WAD = BigInt(1e18)

enum VaultType { MetaMorpho, VaultV2, Unknown }
const vaultTypeCache = new Map<string, VaultType>()

async function identifyVault(ctx: DataHandlerContext<Store>, address: string, blockHeader: BlockHeader): Promise<VaultType> {
    const addr = address.toLowerCase()
    if (vaultTypeCache.has(addr)) return vaultTypeCache.get(addr)!

    // Check DB first
    if (await ctx.store.get(MetaMorphoEntity, addr)) {
        vaultTypeCache.set(addr, VaultType.MetaMorpho)
        return VaultType.MetaMorpho
    }
    if (await ctx.store.get(VaultV2, addr)) {
        vaultTypeCache.set(addr, VaultType.VaultV2)
        return VaultType.VaultV2
    }

    try {
        const contract = new metaMorpho.Contract(ctx, blockHeader, addr)
        // 1. Mandatory Morpho check: must have curator (reverts if not a Morpho vault).
        //    Transient RPC errors are retried in-place; a real revert throws to the
        //    outer catch and is treated as "not a morpho vault".
        await withRpcRetry(() => contract.curator())

        // 2. Check for MORPHO()
        try {
            await withRpcRetry(() => contract.MORPHO())
            vaultTypeCache.set(addr, VaultType.MetaMorpho)
            return VaultType.MetaMorpho
        } catch (err) {
            // A transient failure here is NOT a "no MORPHO()" signal — re-throw so
            // the outer handler avoids caching a wrong verdict.
            if (isTransientRpcError(err)) throw err
        }

        // 3. Check for adapterRegistry() using VaultV2 ABI
        const v2Contract = new vaultV2Abi.Contract(ctx, blockHeader, addr)
        try {
            await withRpcRetry(() => v2Contract.adapterRegistry())
            vaultTypeCache.set(addr, VaultType.VaultV2)
            return VaultType.VaultV2
        } catch (err) {
            if (isTransientRpcError(err)) throw err
        }

        // curator() succeeded but it's neither a MetaMorpho nor a VaultV2 we model.
        // This is a deterministic verdict — safe to cache.
        vaultTypeCache.set(addr, VaultType.Unknown)
        return VaultType.Unknown
    } catch (err: any) {
        if (isTransientRpcError(err)) {
            // Transient RPC failure (rate limit / 5xx / timeout) — do NOT cache.
            // Leaving it uncached lets a later event re-probe instead of
            // permanently blacklisting what may be a real vault.
            ctx.log.warn(`identifyVault(${addr}): transient RPC error, will retry on next event: ${err?.message ?? err}`)
            return VaultType.Unknown
        }
        // curator() reverted → genuinely not a morpho vault → safe to cache.
        vaultTypeCache.set(addr, VaultType.Unknown)
        return VaultType.Unknown
    }
}

// ---- Helpers ----

function positionId(account: string, market: string, side: PositionSide) {
    return `${account}-${market}-${side}`
}

function eventId(txHash: string, logIndex: number) {
    return `${txHash}-${logIndex}`
}

/**
 * A closed Position row (same `account-market-side` id) being supplied/borrowed
 * into again is the SAME position resuming — the id scheme has no sequence
 * suffix, so we reuse the row. Restore its open state and counters, but do NOT
 * bump cumulativePositionCount: this position was already counted when first
 * opened. No-ops if the position is already active.
 */
function reopenClosedPosition(pos: Position, account: Account, protocol: LendingProtocol): void {
    if (pos.isActive) return
    pos.isActive = true
    pos.timestampClosed = null
    pos.blockNumberClosed = null
    account.openPositionCount += 1
    account.closedPositionCount -= 1
    protocol.openPositionCount += 1
}

/**
 * Compute annualised APY from a per-second WAD-scaled rate.
 * Uses the linear approximation: APY ≈ ratePerSecond * SECONDS_PER_YEAR
 * Returns a BigInt suitable for storing as BigDecimal (WAD-scaled).
 */
function annualisedAPY(ratePerSecond: bigint): number {
    const raw = ratePerSecond * BigInt(SECONDS_PER_YEAR)
    return Number(raw) / 1e18
}

/**
 * Apply a signed delta to a stored (vault, market) flow cap. Both sides are
 * clamped at zero — the on-chain uint128 arithmetic can never go negative, so
 * a negative result here only ever means we missed the seeding SetFlowCaps
 * (e.g. it predates START_BLOCK) and should be treated as "no capacity".
 */
async function adjustFlowCap(
    ctx: DataHandlerContext<Store>,
    vaultAddr: string,
    marketId: string,
    deltaIn: bigint,
    deltaOut: bigint,
    nowSec: bigint,
): Promise<void> {
    const cap = await ctx.store.get(PublicAllocatorFlowCap, `${vaultAddr}-${marketId}`)
    if (!cap) return
    cap.maxIn = cap.maxIn + deltaIn > 0n ? cap.maxIn + deltaIn : 0n
    cap.maxOut = cap.maxOut + deltaOut > 0n ? cap.maxOut + deltaOut : 0n
    cap.lastUpdate = nowSec
    await ctx.store.upsert(cap)
}

async function getVaultV2Adapters(ctx: DataHandlerContext<Store>, vaultId: string, blockHeader: BlockHeader): Promise<string[]> {
    const contract = new vaultV2Abi.Contract(ctx, blockHeader, vaultId);
    const len = Number(await contract.adaptersLength());
    const adapters: string[] = [];
    for (let i = 0; i < len; i++) {
        const addr = await contract.adapters(BigInt(i));
        adapters.push(addr.toLowerCase());
    }
    // ctx.log.info(`VaultV2 ${vaultId}: found ${adapters.length} adapters: ${adapters.join(', ')}`);
    return adapters;
}

async function computeVaultAPY(
    ctx: DataHandlerContext<Store>,
    vaultId: string,
    isVaultV2: boolean,
    blockHeader: BlockHeader
): Promise<number> {
    // For MetaMorpho: positions are held by the vault directly
    // For VaultV2: positions are held by the vault's adapters
    let accountIds: string[];
    if (isVaultV2) {
        accountIds = await getVaultV2Adapters(ctx, vaultId, blockHeader);
        if (accountIds.length === 0) {
            ctx.log.info(`computeVaultAPY(${vaultId}): VaultV2 has no adapters`);
            return 0;
        }
    } else {
        accountIds = [vaultId];
    }

    // Query LENDER positions for all relevant account IDs
    const allPositions: Position[] = [];
    for (const accId of accountIds) {
        const positions = await ctx.store.find(Position, {
            where: { account: { id: accId }, side: PositionSide.LENDER },
            relations: { market: { borrowedToken: true } }
        });
        allPositions.push(...positions);
    }

    // ctx.log.info(`computeVaultAPY(${vaultId}): found ${allPositions.length} LENDER positions across ${accountIds.length} accounts`);

    let totalAssets = 0;
    let weightedApySum = 0;

    for (const pos of allPositions) {
        const market = pos.market;
        if (!market || pos.shares <= 0n || market.totalSupplyShares <= 0n) continue;

        // Was reading pos.balance here, which held assets — multiplying assets by
        // the share price inflated every weight. pos.shares is the real share
        // balance, which is what this conversion expects.
        const assetsBase = (pos.shares * market.totalSupplyAssets) / market.totalSupplyShares;
        const decimals = market.borrowedToken?.decimals ?? 18;
        const assets = Number(assetsBase) / (10 ** decimals);
        const mktApy = Number(market.supplyAPY) || 0;

        // ctx.log.info(`  market=${market.id.slice(0, 10)}.. balance=${pos.balance} supplyAPY=${market.supplyAPY} mktApy=${mktApy} assets=${assets}`);

        weightedApySum += assets * mktApy;
        totalAssets += assets;
    }

    const result = totalAssets > 0 ? weightedApySum / totalAssets : 0;
    // ctx.log.info(`  => weighted APY=${result}, totalAssets=${totalAssets}`);
    return result;
}

/**
 * Convert a share balance to its current asset value.
 *
 * Morpho is share-denominated on both the supply and borrow side: the assets a
 * position is worth grow as interest accrues, so assets can never be tracked as
 * a running sum of event amounts. Doing that makes a full withdrawal subtract
 * more than was ever supplied (the difference being earned interest) and drives
 * the stored balance negative — which is what produced negative vault
 * liquidity, since the gateway sums these balances.
 *
 * Callers must apply the event's effect to the market totals *before* calling
 * these, so the conversion uses post-event state.
 */
function lenderAssets(shares: bigint, market: Market): bigint {
    if (shares <= 0n || market.totalSupplyShares <= 0n) return 0n
    return (shares * market.totalSupplyAssets) / market.totalSupplyShares
}

function borrowerAssets(shares: bigint, market: Market): bigint {
    if (shares <= 0n || market.totalBorrowShares <= 0n) return 0n
    return (shares * market.totalBorrowAssets) / market.totalBorrowShares
}

/** Shares never go below zero; rounding on the final exit must not underflow. */
const floor0 = (v: bigint): bigint => (v > 0n ? v : 0n)

/**
 * Push a market's interest accrual into every vault allocated to it.
 *
 * A MetaMorpho vault's assets are its supply positions across markets. When a
 * market accrues, its share price rises and every vault holding it is worth
 * more — but `vault.totalAssets` was only written on the vault's own deposit /
 * withdraw / UpdateLastTotalAssets events, so between those it silently drifted
 * below chain by exactly the interest earned. Quiet, high-yield vaults drifted
 * furthest (Edge UltraYield pUSD sat 6.7% under chain).
 *
 * Each affected vault is recomputed from scratch — summing the derived asset
 * value of its positions — rather than nudged by a delta. A full recompute is
 * self-healing: it cannot accumulate error, and it repairs vaults whose stored
 * total was already wrong. It also refreshes each position's derived `balance`,
 * which otherwise only moved when that position itself was touched.
 */
async function propagateAccrualToVaults(
    ctx: DataHandlerContext<Store>,
    market: Market,
    blockHeader: BlockHeader,
): Promise<void> {
    // This is derived data. If it throws, the batch is retried forever and the
    // processor stops advancing entirely — which is exactly what took indexing
    // down after the first deploy of this change. Log loudly and carry on:
    // stale vault totals are recoverable, a wedged processor is not.
    try {
        await propagateAccrualToVaultsInner(ctx, market, blockHeader)
    } catch (err: any) {
        ctx.log.warn(`propagateAccrualToVaults(${market.id}) failed, skipping: ${err?.stack ?? err}`)
    }
}

/**
 * Rebuild one vault's totalAssets from its market positions, and revalue its
 * depositors against the result.
 *
 * @param fresher a market whose in-memory totals are newer than the stored row
 * (the one currently accruing); preferred over the persisted copy.
 */
async function recomputeVaultAssets(
    ctx: DataHandlerContext<Store>,
    vault: MetaMorphoEntity,
    blockHeader: BlockHeader,
    nowSec: bigint,
    fresher?: Market,
): Promise<void> {
    const allocs = await ctx.store.find(MetaMorphoMarketAllocation, {
        where: { vault: { id: vault.id } },
        relations: { market: true },
    })

    let total = 0n
    for (const alloc of allocs) {
        const mkt = fresher && alloc.market?.id === fresher.id ? fresher : alloc.market
        if (!mkt) continue

        const pos = await ctx.store.get(Position, positionId(vault.id, mkt.id, PositionSide.LENDER))
        if (!pos) continue

        const assets = lenderAssets(pos.shares, mkt)
        if (assets !== pos.balance) {
            pos.balance = assets
            await ctx.store.upsert(pos)
        }
        total += assets
    }

    if (total === vault.totalAssets) return
    await updateVaultState(ctx, vault, nowSec, vault.totalSupply, total, false, blockHeader)
    await ctx.store.upsert(vault)

    // Depositors hold shares of that NAV, so their assets move with it.
    const depositors = await ctx.store.find(MetaMorphoPosition, {
        where: { vault: { id: vault.id } },
    })
    for (const depositor of depositors) {
        const assets = shareholderAssets(depositor.shares, vault)
        if (assets === depositor.assets) continue
        depositor.assets = assets
        await ctx.store.upsert(depositor)
    }
}

/**
 * One-time repair of vault totals left corrupted by the old accounting.
 *
 * `vault.totalAssets` was a running sum of deposit/withdraw amounts. Withdrawals
 * carry accrued interest that was never added on the way in, so the sum drifts
 * down and can underflow — Win HONEY on Berachain sits at -0.1627.
 *
 * propagateAccrualToVaults() repairs a vault the next time one of its markets
 * accrues, but a vault whose markets are idle never gets that trigger and would
 * stay wrong indefinitely. This sweeps every vault once at startup instead.
 *
 * Gated on backfillPositionShares: totals are derived from position shares, so
 * running before those are restored would compute zeros.
 */
let vaultAssetsRepaired = false

async function repairVaultAssets(ctx: any): Promise<void> {
    if (vaultAssetsRepaired) return
    if (!positionSharesBackfilled) return

    const header = ctx.blocks?.[ctx.blocks.length - 1]?.header
    if (!header) return
    vaultAssetsRepaired = true

    try {
        const vaults: MetaMorphoEntity[] = await ctx.store.find(MetaMorphoEntity, {
            relations: { asset: true },
        })
        const nowSec = BigInt(Math.floor(header.timestamp / 1000))
        let repaired = 0

        for (const vault of vaults) {
            const before = vault.totalAssets
            await recomputeVaultAssets(ctx, vault, header, nowSec)
            if (vault.totalAssets !== before) {
                repaired++
                ctx.log.info(`repairVaultAssets ${vault.id}: totalAssets ${before} -> ${vault.totalAssets}`)
            }
        }

        ctx.log.info(`repairVaultAssets: ${repaired}/${vaults.length} vault(s) corrected`)
    } catch (err: any) {
        vaultAssetsRepaired = false
        ctx.log.warn(`repairVaultAssets failed, will retry: ${err?.stack ?? err}`)
    }
}

async function propagateAccrualToVaultsInner(
    ctx: DataHandlerContext<Store>,
    market: Market,
    blockHeader: BlockHeader,
): Promise<void> {
    const holders = await ctx.store.find(MetaMorphoMarketAllocation, {
        where: { market: { id: market.id } },
        relations: { vault: { asset: true } },
    })
    if (holders.length === 0) return

    const nowSec = BigInt(Math.floor(blockHeader.timestamp / 1000))
    const done = new Set<string>()

    for (const holder of holders) {
        const vault = holder.vault
        if (!vault || done.has(vault.id)) continue
        done.add(vault.id)
        await recomputeVaultAssets(ctx, vault, blockHeader, nowSec, market)
    }
}

/**
 * Read a V2 vault's authoritative ERC4626 state.
 *
 * V2 allocates through adapters that this indexer does not track, so unlike V1
 * there are no per-market positions to sum — `totalAssets()` on the vault is
 * the only source of truth. It was previously maintained as a running sum of
 * deposit/withdraw amounts, which tracks net principal rather than NAV and so
 * misses yield, fees, losses and adapter revaluation entirely. Wrapped Re7 RWA
 * Yield had drifted 11.5% *above* chain that way.
 *
 * Returns null when the read fails; callers fall back to their previous value
 * rather than writing a fabricated one.
 */
async function readVaultV2State(
    ctx: DataHandlerContext<Store>,
    // Only the height is used, so callers may pass a batch header or a bare
    // head reference from headBlock().
    block: { height: number },
    address: string,
): Promise<{ totalAssets: bigint; totalSupply: bigint } | null> {
    try {
        const contract = new vaultV2Abi.Contract(ctx, block, address)
        const [totalAssets, totalSupply] = await Promise.all([
            contract.totalAssets(),
            contract.totalSupply(),
        ])
        return { totalAssets, totalSupply }
    } catch {
        return null
    }
}

/**
 * Periodically re-read every V2 vault's NAV from chain.
 *
 * Reading on vault events is not enough on its own: a V2 vault's NAV moves
 * whenever its adapters' underlying positions accrue or revalue, which emits
 * nothing on the vault itself. Wrapped Re7 RWA Yield opened an 11.5% gap purely
 * between events. V1 gets this from propagateAccrualToVaults(); V2 has no
 * indexed adapter positions to drive that, so it is polled instead.
 *
 * Cheap by construction — a handful of V2 vaults, two calls each, once every
 * VAULT_V2_REFRESH_BLOCKS blocks. Set to 0 to disable.
 */
const V2_REFRESH_BLOCKS = Number(process.env.VAULT_V2_REFRESH_BLOCKS ?? 100)
let lastV2RefreshHeight = 0

async function refreshVaultV2State(ctx: any): Promise<void> {
    if (!Number.isFinite(V2_REFRESH_BLOCKS) || V2_REFRESH_BLOCKS <= 0) return

    const header = ctx.blocks?.[ctx.blocks.length - 1]?.header
    if (!header) return

    if (header.height - lastV2RefreshHeight < V2_REFRESH_BLOCKS) return

    // Reconcile against live NAV, not the indexed block. Gating on the batch
    // being near head instead meant this never ran under portal ingestion.
    const at = await headBlock(ctx)
    if (!at) return

    // Only after the head lookup succeeds, so a failed one retries next batch
    // instead of silently burning a whole refresh interval.
    lastV2RefreshHeight = header.height

    try {
        const vaults: VaultV2[] = await ctx.store.find(VaultV2, { relations: { asset: true } })
        if (vaults.length === 0) return

        const nowSec = BigInt(Math.floor(header.timestamp / 1000))
        for (const vault of vaults) {
            const state = await readVaultV2State(ctx, at, vault.id)
            if (!state) continue
            if (state.totalAssets === vault.totalAssets && state.totalSupply === vault.totalSupply) continue

            const before = vault.totalAssets
            await updateVaultState(ctx, vault, nowSec, state.totalSupply, state.totalAssets, true, header)
            await ctx.store.upsert(vault)

            // Holders' assets are a share of NAV, so they move with it.
            const positions: VaultV2Position[] = await ctx.store.find(VaultV2Position, {
                where: { vault: { id: vault.id } },
            })
            for (const pos of positions) {
                const assets = shareholderAssets(pos.shares, vault)
                if (assets === pos.assets) continue
                pos.assets = assets
                await ctx.store.upsert(pos)
            }

            ctx.log.info(
                `refreshVaultV2State ${vault.id}: totalAssets ${before} -> ${vault.totalAssets}` +
                ` (${positions.length} position(s) revalued)`,
            )
        }
    } catch (err: any) {
        // Polling is best-effort; the next interval retries.
        ctx.log.warn(`refreshVaultV2State failed: ${err?.message ?? err}`)
    }
}

/**
 * A vault depositor's assets are their share of NAV, never a sum of past
 * deposits. Applies to MetaMorpho and V2 alike — both are ERC4626, so a holder
 * earns yield without any event touching their position.
 */
function shareholderAssets(
    shares: bigint,
    vault: { totalAssets: bigint; totalSupply: bigint },
): bigint {
    if (shares <= 0n || vault.totalSupply <= 0n) return 0n
    return (shares * vault.totalAssets) / vault.totalSupply
}

// calcUSD is now imported from ./utils/prices

async function updateVaultState(
    ctx: DataHandlerContext<Store>,
    vault: any,
    nowSec: bigint,
    newTotalSupply: bigint,
    newTotalAssets: bigint,
    isVaultV2: boolean,
    blockHeader: BlockHeader
) {
    // Always update balances first so they're never lost on APY errors
    vault.lastTotalAssets = vault.totalAssets;
    vault.lastTotalAssetsTimestamp = nowSec;
    vault.totalSupply = newTotalSupply;
    vault.totalAssets = newTotalAssets;

    // Calculate totalAssetsUSD using on-chain price feed
    const assetToken = vault.asset;
    const decimals = assetToken?.decimals ?? 18;
    const price = await getTokenPriceInUsd(ctx, assetToken?.id ?? '', blockHeader);
    vault.totalAssetsUSD = calcUSD(newTotalAssets, decimals, price) as any;

    // Compute weighted APY from underlying market allocations (error-safe)
    try {
        const apy = await computeVaultAPY(ctx, vault.id, isVaultV2, blockHeader);
        vault.apy = apy as any;
        // ctx.log.info(`Vault ${vault.id}: APY=${apy}, totalAssets=${newTotalAssets}, totalSupply=${newTotalSupply}`);
    } catch (err: any) {
        ctx.log.warn(`computeVaultAPY failed for ${vault.id}: ${err.message ?? err}`);
    }
}

async function getOrCreateToken(ctx: DataHandlerContext<Store>, address: string, blockHeader: BlockHeader): Promise<Token> {
    let token = await ctx.store.get(Token, address)
    if (!token) {
        // Try to fetch real token metadata via ERC20 RPC calls
        let name = address.slice(0, 8)
        let symbol = '???'
        let decimals = 18
        try {
            const contract = new erc20Abi.Contract(ctx, blockHeader, address)
            const [n, s, d] = await Promise.all([
                contract.name().catch(() => address.slice(0, 8)),
                contract.symbol().catch(() => '???'),
                contract.decimals().catch(() => 18),
            ])
            name = n
            symbol = s
            decimals = Number(d)
        } catch { /* fallback to defaults */ }
        token = new Token({
            id: address,
            name,
            symbol,
            decimals,
        })
        await ctx.store.upsert(token)
    }
    return token
}

async function getOrCreateAccount(ctx: DataHandlerContext<Store>, address: string): Promise<Account> {
    let account = await ctx.store.get(Account, address)
    if (!account) {
        account = new Account({
            id: address,
            positionCount: 0,
            openPositionCount: 0,
            closedPositionCount: 0,
        })
        await ctx.store.upsert(account)
    }
    return account
}

async function getOrCreateProtocol(ctx: DataHandlerContext<Store>): Promise<LendingProtocol> {
    let protocol = await ctx.store.get(LendingProtocol, PROTOCOL_ID)
    if (!protocol) {
        protocol = new LendingProtocol({
            id: PROTOCOL_ID,
            name: 'Morpho Blue',
            slug: 'morpho-blue',
            schemaVersion: '3.1.0',
            subgraphVersion: '1.0.0',
            methodologyVersion: '1.0.0',
            network: NETWORK,
            type: 'LENDING',
            lendingType: 'POOLED',
            totalValueLockedUSD: 0n as any,
            totalBorrowBalanceUSD: 0n as any,
            totalDepositBalanceUSD: 0n as any,
            cumulativeBorrowUSD: 0n as any,
            cumulativeDepositUSD: 0n as any,
            cumulativeLiquidateUSD: 0n as any,
            totalPoolCount: 0,
            openPositionCount: 0,
            cumulativePositionCount: 0,
        })
        await ctx.store.upsert(protocol)
    }
    return protocol
}

// ---- Dynamic Vault Creation ----

async function getOrCreateMetaMorpho(
    ctx: DataHandlerContext<Store>,
    address: string,
    blockHeader: BlockHeader
): Promise<MetaMorphoEntity | null> {
    const addr = address.toLowerCase()
    let vault = await ctx.store.get(MetaMorphoEntity, { where: { id: addr }, relations: { asset: true } })
    if (vault) return vault

    // Use the MetaMorpho ABI contract wrapper for RPC calls
    const contract = new metaMorpho.Contract(ctx, blockHeader, addr)
    try {
        const [name, symbol, assetAddr, ownerAddr, fee, timelock] = await Promise.all([
            contract.name(),
            contract.symbol(),
            contract.asset(),
            contract.owner(),
            contract.fee(),
            contract.timelock(),
        ])

        let curatorAddr: string | null = null
        try {
            curatorAddr = await contract.curator()
        } catch { /* curator may not exist */ }

        let feeRecipient: string | null = null
        try {
            feeRecipient = await contract.feeRecipient()
        } catch { /* feeRecipient may not exist */ }

        // v1 only — VaultV2 has no guardian() and reverts on the call.
        let guardian: string | null = null
        try {
            guardian = await contract.guardian()
        } catch { /* guardian may not exist */ }

        const assetToken = await getOrCreateToken(ctx, assetAddr.toLowerCase(), blockHeader)
        const ownerAccount = await getOrCreateAccount(ctx, ownerAddr.toLowerCase())
        let curatorAccount: Account | undefined = undefined
        if (curatorAddr) {
            curatorAccount = await getOrCreateAccount(ctx, curatorAddr.toLowerCase())
        }

        vault = new MetaMorphoEntity({
            id: addr,
            name,
            symbol,
            asset: assetToken,
            owner: ownerAccount,
            curator: curatorAccount,
            guardian: guardian ? guardian.toLowerCase() : undefined,
            fee: BigInt(fee),
            feeRecipient: feeRecipient ?? undefined,
            timelock: BigInt(timelock),
            totalAssets: 0n,
            totalSupply: 0n,
            totalAssetsUSD: BigInt(0) as any,
            apy: BigInt(0) as any,
            lastTotalAssets: 0n,
            lastTotalAssetsTimestamp: 0n,
        })

        // Fetch real on-chain totalAssets/totalSupply
        try {
            const v2Reader = new vaultV2Abi.Contract(ctx, blockHeader, addr)
            const [ta, ts] = await Promise.all([
                v2Reader.totalAssets(),
                v2Reader.totalSupply(),
            ])
            vault.totalAssets = ta
            vault.totalSupply = ts
            const decimals = assetToken.decimals ?? 18
            const price = await getTokenPriceInUsd(ctx, assetToken.id, blockHeader)
            vault.totalAssetsUSD = calcUSD(ta, decimals, price) as any
            // ctx.log.info(`MetaMorpho ${addr}: initialized totalAssets=${ta}, totalSupply=${ts}`)
        } catch (e) {
            ctx.log.warn(`MetaMorpho ${addr}: could not fetch totalAssets/totalSupply via RPC`)
        }

        await ctx.store.upsert(vault)
        ctx.log.info(`Created MetaMorpho vault: ${addr} (${name})`)
        return vault
    } catch (err) {
        // Not a MetaMorpho vault — silently skip
        ctx.log.warn(`Could not create MetaMorpho vault for ${addr}: ${err}`)
        return null
    }
}

/**
 * Re-sync vault role/fee columns from chain, once per processor start.
 *
 * `getOrCreateMetaMorpho` / `getOrCreateVaultV2` return early for a vault that
 * already exists, so a column added after that vault was first indexed is
 * never populated by the normal path. Three values need this:
 *
 *   meta_morpho.guardian     - added later; null on every pre-existing row
 *   meta_morpho.fee          - written once at creation and, before SetFee was
 *                              handled, never updated. This one changes numbers
 *                              users see: net supply APY is derived as
 *                              apy(row.apy, fee/WAD), so a stale zero fee
 *                              overstates the APY.
 *   vault_v2.performance_fee - added later; 0 on every pre-existing row
 *
 * All three are current on-chain state rather than historical series, so one
 * read per vault is enough — no re-index. It runs on every start (cheap: a few
 * dozen calls) so the columns also self-heal after any missed event. Set
 * BACKFILL_VAULT_ROLES=false to skip it.
 */
/**
 * Current chain head, as a block reference for contract reads.
 *
 * The batch header is the wrong reference for backfills and refreshes. Under
 * portal ingestion it is finalized-only and can sit far behind head — 59k blocks
 * on Plume when its dataset stalled — and a non-archive RPC cannot serve state
 * at a height that old. These callers all want *current* state anyway, so they
 * read at head and are then independent of how far the portal has got.
 *
 * @subsquid/evm-abi only needs `{height}` for the eth_call block parameter.
 */
async function headBlock(ctx: any): Promise<{ height: number } | null> {
    try {
        const hex = await ctx._chain.client.call('eth_blockNumber')
        const height = parseInt(hex, 16)
        return Number.isFinite(height) ? { height } : null
    } catch {
        return null
    }
}

let vaultRolesBackfilled = false
let vaultRolesAttempts = 0
const VAULT_ROLES_MAX_ATTEMPTS = 3

async function backfillVaultRoles(ctx: any): Promise<void> {
    if (vaultRolesBackfilled) return
    if (process.env.BACKFILL_VAULT_ROLES === 'false') {
        vaultRolesBackfilled = true
        return
    }

    // Contract reads need a block to pin to; wait for a batch that has one.
    const header = ctx.blocks?.[0]?.header
    if (!header) return
    // ...but read at head, not at the indexed block — see headBlock(). If head
    // can't be determined, defer: reading at a possibly-ancient indexed block is
    // the exact failure this avoids.
    const at = await headBlock(ctx)
    if (!at) return
    vaultRolesBackfilled = true

    const stats = { guardian: 0, fee: 0, performanceFee: 0, identity: 0, unreachable: 0 }

    /**
     * Repair a vault whose name/symbol were stored empty.
     *
     * Both are read once in getOrCreate*, at the block of the event that first
     * surfaced the vault. A proxy that is deployed but not yet initialised
     * answers name()/symbol() with an empty string rather than reverting, so ''
     * gets persisted — and getOrCreate* returns early ever after, so it is never
     * re-read. Three Flare V2 vaults sat nameless this way while the chain had
     * had "Core USDT0"/"Core FXRP"/"Core wFLR" all along.
     *
     * Only fills blanks; a vault that already has a name is left alone.
     */
    const repairIdentity = async (vault: { id: string; name: string; symbol: string }): Promise<boolean> => {
        if (vault.name && vault.symbol) return false
        try {
            // V2 shares the ERC4626/ERC20 surface, so one ABI covers both.
            const erc = new metaMorpho.Contract(ctx, at, vault.id)
            const [name, symbol] = await Promise.all([erc.name(), erc.symbol()])
            let changed = false
            if (!vault.name && name) { vault.name = name; changed = true }
            if (!vault.symbol && symbol) { vault.symbol = symbol; changed = true }
            if (changed) {
                stats.identity++
                ctx.log.info(`backfill ${vault.id}: identity -> "${vault.name}" (${vault.symbol})`)
            }
            return changed
        } catch {
            return false
        }
    }

    try {
        const v1: MetaMorphoEntity[] = await ctx.store.find(MetaMorphoEntity, {})
        for (const vault of v1) {
            const contract = new metaMorpho.Contract(ctx, at, vault.id)
            let changed = false

            try {
                const guardian = (await contract.guardian()).toLowerCase()
                if (guardian !== vault.guardian) {
                    vault.guardian = guardian
                    stats.guardian++
                    changed = true
                }
            } catch { /* guardian() absent on this deployment */ }

            try {
                const fee = BigInt(await contract.fee())
                if (fee !== vault.fee) {
                    ctx.log.info(
                        `backfill ${vault.id}: fee ${Number(vault.fee) / 1e16}% -> ${Number(fee) / 1e16}%` +
                        ` (net supply APY was being reported against the stale value)`,
                    )
                    vault.fee = fee
                    stats.fee++
                    changed = true
                }
            } catch { stats.unreachable++ }

            if (await repairIdentity(vault)) changed = true
            if (changed) await ctx.store.upsert(vault)
        }

        const v2: VaultV2[] = await ctx.store.find(VaultV2, {})
        for (const vault of v2) {
            let changed = await repairIdentity(vault)

            try {
                const fee = BigInt(await new vaultV2Abi.Contract(ctx, at, vault.id).performanceFee())
                if (fee !== vault.performanceFee) {
                    vault.performanceFee = fee
                    stats.performanceFee++
                    changed = true
                }
            } catch { /* performanceFee() absent on older V2 deployments */ }

            if (changed) await ctx.store.upsert(vault)
        }

        if (stats.guardian || stats.fee || stats.performanceFee || stats.identity || stats.unreachable) {
            ctx.log.info(
                `backfillVaultRoles: guardian=${stats.guardian} fee=${stats.fee}` +
                ` performanceFee=${stats.performanceFee} identity=${stats.identity}` +
                ` unreachable=${stats.unreachable} (v1=${v1.length} v2=${v2.length})`,
            )
        }
    } catch (err: any) {
        // Never let a backfill failure stop indexing. Retry on the next batch,
        // but only a few times — a persistently unreachable RPC must not turn
        // into a per-batch call storm. After that it waits for a restart.
        vaultRolesAttempts++
        const willRetry = vaultRolesAttempts < VAULT_ROLES_MAX_ATTEMPTS
        vaultRolesBackfilled = !willRetry
        ctx.log.warn(
            `backfillVaultRoles failed (attempt ${vaultRolesAttempts}/${VAULT_ROLES_MAX_ATTEMPTS}), ` +
            `${willRetry ? 'retrying next batch' : 'giving up until restart'}: ${err?.message ?? err}`,
        )
    }
}

/**
 * Repopulate position.shares from chain, once per processor start.
 *
 * The migration zeroes LENDER/BORROWER balances because the pre-share
 * accounting corrupted them beyond repair in SQL (see the migration header).
 * Morpho Blue's position(id, user) returns the authoritative supplyShares /
 * borrowShares, so one read per position restores the truth without a
 * re-index. Runs only while rows still need it, so a healthy DB costs nothing
 * beyond the initial count query.
 */
const POSITION_BACKFILL_CHUNK = Number(process.env.POSITION_BACKFILL_CHUNK ?? 200)
const POSITION_BACKFILL_MAX_PASSES = 3
let positionSharesBackfilled = false
let positionBackfillCursor = ''
let positionBackfillFailures = 0
let positionBackfillPass = 0

async function backfillPositionShares(ctx: any): Promise<void> {
    if (positionSharesBackfilled) return
    if (process.env.BACKFILL_POSITION_SHARES === 'false') {
        positionSharesBackfilled = true
        return
    }

    const header = ctx.blocks?.[ctx.blocks.length - 1]?.header
    if (!header) return

    // `position()` is a state read and we want current shares, so pin it to head
    // rather than the indexed block. This previously gated on the batch being
    // near head instead, which never opened under portal ingestion — the portal
    // is finalized-only and was 59k blocks behind on Plume — so on every portal
    // network this backfill silently never ran.
    const at = await headBlock(ctx)
    if (!at) return

    try {
        // Cursor-paginated: this used to load every stale position and issue one
        // sequential RPC call each, inside the batch handler — thousands of calls
        // blocking the processor from advancing at all.
        const cursor = positionBackfillCursor
            ? { id: MoreThan(positionBackfillCursor) }
            : {}
        const stale: Position[] = await ctx.store.find(Position, {
            where: [
                { ...cursor, side: PositionSide.LENDER, shares: 0n },
                { ...cursor, side: PositionSide.BORROWER, shares: 0n },
            ],
            relations: { market: true },
            order: { id: 'ASC' },
            take: POSITION_BACKFILL_CHUNK,
        })

        if (stale.length === 0) {
            // The cursor advances past failed reads so the pass can finish, which
            // would otherwise skip those positions for good. Sweep again instead
            // of declaring victory over balances we never actually restored.
            if (positionBackfillFailures > 0 && positionBackfillPass < POSITION_BACKFILL_MAX_PASSES - 1) {
                positionBackfillPass++
                ctx.log.warn(
                    `backfillPositionShares: pass ${positionBackfillPass} had ` +
                    `${positionBackfillFailures} failed read(s) — sweeping again`,
                )
                positionBackfillCursor = ''
                positionBackfillFailures = 0
                return
            }
            positionSharesBackfilled = true
            ctx.log.info(
                positionBackfillFailures > 0
                    ? `backfillPositionShares: giving up with ${positionBackfillFailures} unrestored position(s)`
                    : 'backfillPositionShares: complete',
            )
            return
        }

        const contract = new morphoBlue.Contract(ctx, at, MORPHO_BLUE)
        let restored = 0
        let failed = 0

        for (const pos of stale) {
            const market = pos.market
            if (!market) continue
            const account = (pos.id.split('-')[0] ?? '').toLowerCase()
            if (!account.startsWith('0x')) continue

            try {
                const onChain = await contract.position(market.id, account)
                pos.shares = pos.side === PositionSide.LENDER
                    ? BigInt(onChain.supplyShares)
                    : BigInt(onChain.borrowShares)
                pos.balance = pos.side === PositionSide.LENDER
                    ? lenderAssets(pos.shares, market)
                    : borrowerAssets(pos.shares, market)
                if (pos.shares > 0n) restored++
                await ctx.store.upsert(pos)
            } catch (err: any) {
                // Surface the first failure per chunk — silently swallowing these
                // is what hid the problem last time.
                failed++
                if (failed === 1) {
                    ctx.log.warn(`backfillPositionShares: read failed for ${pos.id}: ${err?.message ?? err}`)
                }
            }
        }

        // Advance past this chunk. Legitimately zero-share positions keep matching
        // the filter forever, so a cursor — not an offset — is what guarantees
        // forward progress and eventual completion.
        positionBackfillCursor = stale[stale.length - 1].id
        positionBackfillFailures += failed
        ctx.log.info(
            `backfillPositionShares: chunk of ${stale.length} — restored ${restored}, failed ${failed}`,
        )
    } catch (err: any) {
        ctx.log.warn(`backfillPositionShares failed, will retry: ${err?.stack ?? err}`)
    }
}

async function getOrCreateVaultV2(
    ctx: DataHandlerContext<Store>,
    address: string,
    blockHeader: BlockHeader
): Promise<VaultV2 | null> {
    const addr = address.toLowerCase()
    let vault = await ctx.store.get(VaultV2, { where: { id: addr }, relations: { asset: true } })
    if (vault) return vault

    // VaultV2 shares the same ERC4626 interface, reuse MetaMorpho ABI for name/symbol/asset/owner
    const contract = new metaMorpho.Contract(ctx, blockHeader, addr)
    try {
        const [name, symbol, assetAddr, ownerAddr] = await Promise.all([
            contract.name(),
            contract.symbol(),
            contract.asset(),
            contract.owner(),
        ])

        let curatorAddr: string | null = null
        try {
            curatorAddr = await contract.curator()
        } catch { /* curator may not exist */ }

        // performanceFee() is on the V2 vault itself, not the shared ERC4626
        // surface, so it needs the VaultV2 ABI. Older deployments predate the
        // accessor and revert — those keep a zero fee.
        let performanceFee = 0n
        try {
            performanceFee = await new vaultV2Abi.Contract(ctx, blockHeader, addr).performanceFee()
        } catch { /* performanceFee may not exist */ }

        const assetToken = await getOrCreateToken(ctx, assetAddr.toLowerCase(), blockHeader)
        const ownerAccount = await getOrCreateAccount(ctx, ownerAddr.toLowerCase())
        let curatorAccount: Account | undefined = undefined
        if (curatorAddr) {
            curatorAccount = await getOrCreateAccount(ctx, curatorAddr.toLowerCase())
        }

        vault = new VaultV2({
            id: addr,
            name,
            symbol,
            asset: assetToken,
            owner: ownerAccount,
            curator: curatorAccount,
            performanceFee,
            totalAssets: 0n,
            totalSupply: 0n,
            totalAssetsUSD: BigInt(0) as any,
            apy: BigInt(0) as any,
            lastTotalAssets: 0n,
            lastTotalAssetsTimestamp: 0n,
        })

        // Fetch real on-chain totalAssets/totalSupply
        try {
            const v2Reader = new vaultV2Abi.Contract(ctx, blockHeader, addr)
            const [ta, ts, name, symbol, ownerAddr] = await Promise.all([
                v2Reader.totalAssets(),
                v2Reader.totalSupply(),
                contract.name(),
                contract.symbol(),
                contract.owner(),
            ])
            const ownerAccount = await getOrCreateAccount(ctx, ownerAddr.toLowerCase())
            vault.totalAssets = ta
            vault.totalSupply = ts
            vault.name = name
            vault.symbol = symbol
            vault.owner = ownerAccount
            const decimals = assetToken.decimals ?? 18
            const price = await getTokenPriceInUsd(ctx, assetToken.id, blockHeader)
            vault.totalAssetsUSD = calcUSD(ta, decimals, price) as any
            // ctx.log.info(`VaultV2 ${addr}: initialized totalAssets=${ta}, totalSupply=${ts}`)
        } catch (e) {
            ctx.log.warn(`VaultV2 ${addr}: could not fetch totalAssets/totalSupply via RPC`)
        }

        await ctx.store.upsert(vault)
        ctx.log.info(`Created VaultV2: ${addr} (${name})`)
        return vault
    } catch (err) {
        ctx.log.warn(`Could not create VaultV2 for ${addr}: ${err}`)
        return null
    }
}

// ---- Snapshot Helpers ----

function getDayId(timestampMs: number): number {
    // timestampMs from block.header.timestamp is in milliseconds
    return Math.floor(timestampMs / 1000 / SECONDS_PER_DAY)
}

function getHourId(timestampMs: number): number {
    return Math.floor(timestampMs / 1000 / SECONDS_PER_HOUR)
}

// Markets whose loan asset has no working USD oracle. Warned once each, so the
// log enumerates exactly which loan assets still need a feed rather than
// repeating the same market on every accrual.
const warnedNonUsdLoanAsset = new Set<string>()

async function snapshotMarket(
    ctx: DataHandlerContext<Store>,
    market: Market,
    blockHeight: number,
    timestampMs: number,
    blockHeader: BlockHeader,
): Promise<void> {
    const dayId = getDayId(timestampMs)
    const hourId = getHourId(timestampMs)

    const loanPrice = await getTokenPriceInUsd(ctx, market.borrowedToken?.id ?? '', blockHeader)

    // Read the market's own oracle: the collateral/loan ratio the protocol
    // uses for LTV and liquidation.
    //
    // Only at the chain head. `oraclePrice` and the collateral USD price it
    // feeds are *current* values — nothing historical reads them — so calling
    // price() at every historical block during backfill buys nothing and costs
    // one RPC round trip per event. Under the portal data source that is the
    // difference between a mapping that keeps up with ingestion and one that
    // runs orders of magnitude slower than it.
    const oraclePrice = ctx.isHead
        ? await getMarketOraclePrice(ctx, market.oracle, blockHeader)
        : null
    if (oraclePrice !== null && oraclePrice > 0n) {
        market.oraclePrice = oraclePrice
        market.oraclePriceUpdatedAt = BigInt(Math.floor(timestampMs / 1000))

        // Fill the collateral token's USD price from the oracle when it has no
        // feed of its own. This is what keeps oracle-feeds.json from needing an
        // entry per collateral token: anchor the loan asset (usually a
        // stablecoin) and the collateral prices itself, consistently with what
        // the protocol believes.
        //
        // Gated on the loan asset having a working USD oracle of its own. The
        // market oracle gives a ratio in loan-asset terms, so `ratio x loanUsd`
        // is a USD price only if loanUsd really is USD.
        //
        // The loan asset does NOT have to be a stablecoin. A market like
        // WFLR/FXRP derives correctly as long as FXRP has a feed configured:
        // FXRP resolves through it, and WFLR is then priced in real dollars.
        // What we refuse is the case where the loan asset resolved to the $1
        // placeholder — then the "USD" price would actually be the collateral
        // valued in the loan asset, which looks plausible and means nothing.
        const collateral = market.inputToken
        const loanToken = market.borrowedToken
        const loanIsUsd = loanToken != null && isUsdDenominated(loanToken.id)

        if (collateral && !hasDirectPriceSource(collateral.id)) {
            if (loanIsUsd) {
                const derived = collateralPriceFromOracle(
                    oraclePrice,
                    collateral.decimals,
                    loanToken?.decimals ?? 18,
                    loanPrice,
                )
                if (derived !== null) {
                    await persistTokenPrice(ctx, collateral.id, derived, blockHeight)
                }
            } else if (!warnedNonUsdLoanAsset.has(market.id)) {
                warnedNonUsdLoanAsset.add(market.id)
                ctx.log.warn(
                    `Market ${market.name} (${market.id}): loan asset ` +
                    `${loanToken?.symbol ?? '?'} ${loanToken?.id ?? ''} has no USD price source, ` +
                    `so ${collateral.symbol} cannot be priced from the market oracle ` +
                    `(that would value it in ${loanToken?.symbol ?? 'the loan asset'}, not USD). ` +
                    `Add a feed for ${loanToken?.symbol ?? 'it'} in oracle-feeds.json.`,
                )
            }
        }
    }

    const newDepositUSD = calcUSD(market.totalSupplyAssets, market.borrowedToken?.decimals ?? 18, loanPrice)
    const newBorrowUSD = calcUSD(market.totalBorrowAssets, market.borrowedToken?.decimals ?? 18, loanPrice)

    const deltaDepositUSD = newDepositUSD - (Number(market.totalDepositBalanceUSD) || 0)
    const deltaBorrowUSD = newBorrowUSD - (Number(market.totalBorrowBalanceUSD) || 0)

    market.totalDepositBalanceUSD = newDepositUSD as any
    market.totalBorrowBalanceUSD = newBorrowUSD as any
    market.totalValueLockedUSD = market.totalDepositBalanceUSD
    await ctx.store.upsert(market)

    // Daily snapshot
    const dailyId = `${market.id}-${dayId}`
    let daily = await ctx.store.get(MarketDailySnapshot, dailyId)
    if (!daily) {
        daily = new MarketDailySnapshot({ id: dailyId, market, dayId })
    }
    daily.blockNumber = BigInt(blockHeight)
    daily.timestamp = BigInt(timestampMs)
    daily.totalSupplyAssets = market.totalSupplyAssets
    daily.totalSupplyShares = market.totalSupplyShares
    daily.totalBorrowAssets = market.totalBorrowAssets
    daily.totalBorrowShares = market.totalBorrowShares
    daily.totalValueLockedUSD = market.totalValueLockedUSD
    daily.totalDepositBalanceUSD = market.totalDepositBalanceUSD
    daily.totalBorrowBalanceUSD = market.totalBorrowBalanceUSD
    daily.borrowAPY = market.borrowAPY
    daily.supplyAPY = market.supplyAPY
    await ctx.store.upsert(daily)

    // Hourly snapshot
    const hourlyId = `${market.id}-${hourId}`
    let hourly = await ctx.store.get(MarketHourlySnapshot, hourlyId)
    if (!hourly) {
        hourly = new MarketHourlySnapshot({ id: hourlyId, market, hourId })
    }
    hourly.blockNumber = BigInt(blockHeight)
    hourly.timestamp = BigInt(timestampMs)
    hourly.totalSupplyAssets = market.totalSupplyAssets
    hourly.totalSupplyShares = market.totalSupplyShares
    hourly.totalBorrowAssets = market.totalBorrowAssets
    hourly.totalBorrowShares = market.totalBorrowShares
    hourly.totalValueLockedUSD = market.totalValueLockedUSD
    hourly.totalDepositBalanceUSD = market.totalDepositBalanceUSD
    hourly.totalBorrowBalanceUSD = market.totalBorrowBalanceUSD
    hourly.borrowAPY = market.borrowAPY
    hourly.supplyAPY = market.supplyAPY
    await ctx.store.upsert(hourly)

    // Incrementally update protocol-level TVL from this market's delta
    const protocol = await ctx.store.get(LendingProtocol, PROTOCOL_ID)
    if (protocol) {
        protocol.totalDepositBalanceUSD = ((Number(protocol.totalDepositBalanceUSD) || 0) + deltaDepositUSD) as any
        protocol.totalBorrowBalanceUSD = ((Number(protocol.totalBorrowBalanceUSD) || 0) + deltaBorrowUSD) as any
        protocol.totalValueLockedUSD = protocol.totalDepositBalanceUSD
        await ctx.store.upsert(protocol)
    }
}

async function snapshotMetaMorpho(
    ctx: DataHandlerContext<Store>,
    vault: MetaMorphoEntity,
    blockHeight: number,
    timestampMs: number
): Promise<void> {
    const dayId = getDayId(timestampMs)
    const hourId = getHourId(timestampMs)


    // Daily
    const dailyId = `${vault.id}-${dayId}`
    let daily = await ctx.store.get(MetaMorphoDailySnapshot, dailyId)
    if (!daily) {
        daily = new MetaMorphoDailySnapshot({ id: dailyId, vault, dayId })
    }
    daily.blockNumber = BigInt(blockHeight)
    daily.timestamp = BigInt(timestampMs)
    daily.totalAssets = vault.totalAssets
    daily.totalSupply = vault.totalSupply
    daily.totalAssetsUSD = vault.totalAssetsUSD
    daily.apy = vault.apy
    await ctx.store.upsert(daily)

    // Hourly
    const hourlyId = `${vault.id}-${hourId}`
    let hourly = await ctx.store.get(MetaMorphoHourlySnapshot, hourlyId)
    if (!hourly) {
        hourly = new MetaMorphoHourlySnapshot({ id: hourlyId, vault, hourId })
    }
    hourly.blockNumber = BigInt(blockHeight)
    hourly.timestamp = BigInt(timestampMs)
    hourly.totalAssets = vault.totalAssets
    hourly.totalSupply = vault.totalSupply
    hourly.totalAssetsUSD = vault.totalAssetsUSD
    hourly.apy = vault.apy
    await ctx.store.upsert(hourly)
}

async function snapshotVaultV2(
    ctx: DataHandlerContext<Store>,
    vault: VaultV2,
    blockHeight: number,
    timestampMs: number
): Promise<void> {
    const dayId = getDayId(timestampMs)
    const hourId = getHourId(timestampMs)


    // Daily
    const dailyId = `${vault.id}-${dayId}`
    let daily = await ctx.store.get(VaultV2DailySnapshot, dailyId)
    if (!daily) {
        daily = new VaultV2DailySnapshot({ id: dailyId, vault, dayId })
    }
    daily.blockNumber = BigInt(blockHeight)
    daily.timestamp = BigInt(timestampMs)
    daily.totalAssets = vault.totalAssets
    daily.totalSupply = vault.totalSupply
    daily.totalAssetsUSD = vault.totalAssetsUSD
    daily.apy = vault.apy
    await ctx.store.upsert(daily)

    // Hourly
    const hourlyId = `${vault.id}-${hourId}`
    let hourly = await ctx.store.get(VaultV2HourlySnapshot, hourlyId)
    if (!hourly) {
        hourly = new VaultV2HourlySnapshot({ id: hourlyId, vault, hourId })
    }
    hourly.blockNumber = BigInt(blockHeight)
    hourly.timestamp = BigInt(timestampMs)
    hourly.totalAssets = vault.totalAssets
    hourly.totalSupply = vault.totalSupply
    hourly.totalAssetsUSD = vault.totalAssetsUSD
    hourly.apy = vault.apy
    await ctx.store.upsert(hourly)
}

// Set of addresses that failed RPC and should not be retried again

// ---- Main ----

// Canton network branch — when NETWORK=CANTON, the EVM processor isn't
// applicable (DAML ledger, not EVM blocks). Hand off to the Canton update-
// stream processor and skip the EVM `processor.run` below entirely.
//
// The EVM imports above still execute on a Canton boot, but `processor.ts`
// guards the EvmBatchProcessor instantiation so it's a no-op when the
// required EVM env vars are absent.
if (process.env.NETWORK === 'CANTON') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./canton/main').start().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[canton] fatal', err);
        process.exit(1);
    });
} else {

    // The batch handler, shared by both ingestion paths below. `ctx` must supply
    // store / blocks / isHead / log / _chain and millisecond block timestamps.
    const handleBatch = async (ctx: any) => {
        ctx.log.info(`[processor] Processing batch: blocks ${ctx.blocks[0]?.header.height} to ${ctx.blocks[ctx.blocks.length - 1]?.header.height}`);
        const protocol = await getOrCreateProtocol(ctx)

        for (const block of ctx.blocks) {
            for (const log of block.logs) {
                const addr = log.address.toLowerCase()
                const topic = log.topics[0]

                // ══════════════════════════════════════════
                // MORPHO BLUE CORE EVENTS
                // ══════════════════════════════════════════

                if (addr === MORPHO_BLUE) {

                    // CreateMarket
                    if (topic === morphoBlue.events.CreateMarket.topic) {
                        const { id, marketParams } = morphoBlue.events.CreateMarket.decode(log)
                        const collateralToken = await getOrCreateToken(ctx, marketParams.collateralToken, block.header)
                        const loanToken = await getOrCreateToken(ctx, marketParams.loanToken, block.header)
                        const lltv = marketParams.lltv
                        // LLTV is both the borrow cap and the liquidation line on
                        // Morpho Blue, so maximumLTV and liquidationThreshold are
                        // the same number; the penalty derives from it.
                        const liquidationThreshold = lltvToFraction(lltv)
                        const penalty = liquidationPenaltyFromLltv(lltv)

                        const market = new Market({
                            id,
                            protocol,
                            name: `${collateralToken.symbol}/${loanToken.symbol} ${(liquidationThreshold * 100).toFixed(0)}%`,
                            isActive: true,
                            inputToken: collateralToken,
                            borrowedToken: loanToken,
                            oracle: marketParams.oracle,
                            irm: marketParams.irm,
                            lltv,
                            totalValueLockedUSD: BigInt(0) as any,
                            totalDepositBalanceUSD: BigInt(0) as any,
                            totalBorrowBalanceUSD: BigInt(0) as any,
                            cumulativeDepositUSD: BigInt(0) as any,
                            cumulativeBorrowUSD: BigInt(0) as any,
                            cumulativeLiquidateUSD: BigInt(0) as any,
                            maximumLTV: liquidationThreshold as any,
                            liquidationThreshold: liquidationThreshold as any,
                            liquidationPenalty: penalty as any,
                            totalSupplyAssets: 0n,
                            totalSupplyShares: 0n,
                            totalBorrowAssets: 0n,
                            totalBorrowShares: 0n,
                            lastUpdate: BigInt(block.header.timestamp),
                            fee: 0n,
                            borrowAPY: BigInt(0) as any,
                            supplyAPY: BigInt(0) as any,
                        })
                        await ctx.store.upsert(market)

                        // Create LENDER and BORROWER rate placeholders
                        for (const side of [InterestRateSide.LENDER, InterestRateSide.BORROWER]) {
                            await ctx.store.upsert(new InterestRate({
                                id: `${id}-${side}`,
                                market,
                                rate: BigInt(0) as any,
                                side,
                                type: InterestRateType.VARIABLE,
                            }))
                        }

                        protocol.totalPoolCount += 1
                        await ctx.store.upsert(protocol)

                        // Snapshot market on creation
                        await snapshotMarket(ctx, market, block.header.height, block.header.timestamp, block.header)
                    }

                    // Supply (lend)
                    if (topic === morphoBlue.events.Supply.topic) {
                        const e = morphoBlue.events.Supply.decode(log)
                        const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                        if (!market) continue
                        const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                        const loanPrice = await getTokenPriceInUsd(ctx, market.borrowedToken?.id ?? '', block.header)
                        await ctx.store.upsert(new Deposit({
                            id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                            hash: log.transaction?.hash ?? log.id,
                            logIndex: log.logIndex,
                            protocol,
                            account,
                            market,
                            asset: market.borrowedToken,
                            amount: e.assets,
                            amountUSD: calcUSD(e.assets, market.borrowedToken?.decimals ?? 18, loanPrice) as any,
                            shares: e.shares,
                            onBehalf: e.onBehalf.toLowerCase(),
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                        }))

                        // Update position
                        const posId = positionId(e.onBehalf.toLowerCase(), market.id, PositionSide.LENDER)
                        let pos = await ctx.store.get(Position, posId)
                        if (!pos) {
                            pos = new Position({
                                id: posId, account, market,
                                side: PositionSide.LENDER, isCollateral: false,
                                shares: 0n, balance: 0n, balanceUSD: BigInt(0) as any,
                                isActive: true,
                                timestampOpened: BigInt(block.header.timestamp),
                                blockNumberOpened: BigInt(block.header.height),
                            })
                            account.positionCount += 1
                            account.openPositionCount += 1
                            protocol.openPositionCount += 1
                            protocol.cumulativePositionCount += 1
                        } else {
                            reopenClosedPosition(pos, account, protocol)
                        }
                        pos.shares += e.shares
                        await ctx.store.upsert(account)

                        // Update market totals
                        market.totalSupplyAssets += e.assets
                        market.totalSupplyShares += e.shares

                        // Assets are derived, never accumulated — see lenderAssets().
                        // Must run after the market totals above so the share price
                        // reflects post-event state.
                        pos.balance = lenderAssets(pos.shares, market)
                        pos.balanceUSD = calcUSD(pos.balance, market.borrowedToken?.decimals ?? 18, loanPrice) as any
                        await ctx.store.upsert(pos)

                        const depositUSD = calcUSD(e.assets, market.borrowedToken?.decimals ?? 18, loanPrice)
                        market.cumulativeDepositUSD = ((Number(market.cumulativeDepositUSD) || 0) + depositUSD) as any
                        protocol.cumulativeDepositUSD = ((Number(protocol.cumulativeDepositUSD) || 0) + depositUSD) as any
                        await ctx.store.upsert(market)
                        await ctx.store.upsert(protocol)

                        await snapshotMarket(ctx, market, block.header.height, block.header.timestamp, block.header)
                    }

                    // Withdraw (lender withdraws)
                    if (topic === morphoBlue.events.Withdraw.topic) {
                        const e = morphoBlue.events.Withdraw.decode(log)
                        const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                        if (!market) continue
                        const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                        const loanPrice = await getTokenPriceInUsd(ctx, market.borrowedToken?.id ?? '', block.header)
                        await ctx.store.upsert(new Withdraw({
                            id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                            hash: log.transaction?.hash ?? log.id, logIndex: log.logIndex,
                            protocol, account, market,
                            asset: market.borrowedToken,
                            amount: e.assets, amountUSD: calcUSD(e.assets, market.borrowedToken?.decimals ?? 18, loanPrice) as any,
                            shares: e.shares, onBehalf: e.onBehalf.toLowerCase(),
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                        }))

                        // Update LENDER position
                        const posId = positionId(e.onBehalf.toLowerCase(), market.id, PositionSide.LENDER)
                        let pos = await ctx.store.get(Position, posId)

                        market.totalSupplyAssets -= e.assets
                        market.totalSupplyShares -= e.shares
                        await ctx.store.upsert(market)

                        if (pos) {
                            // Subtract shares, not assets: the withdrawn assets include
                            // accrued interest, so subtracting them from a principal sum
                            // drives the balance negative on a full exit.
                            pos.shares = floor0(pos.shares - e.shares)
                            pos.balance = lenderAssets(pos.shares, market)
                            pos.balanceUSD = calcUSD(pos.balance, market.borrowedToken?.decimals ?? 18, loanPrice) as any
                            if (pos.shares <= 0n && pos.isActive) {
                                pos.isActive = false
                                pos.timestampClosed = BigInt(block.header.timestamp)
                                pos.blockNumberClosed = BigInt(block.header.height)
                                account.openPositionCount -= 1
                                account.closedPositionCount += 1
                                protocol.openPositionCount -= 1
                                await ctx.store.upsert(account)
                                await ctx.store.upsert(protocol)
                            }
                            await ctx.store.upsert(pos)
                        }

                        await snapshotMarket(ctx, market, block.header.height, block.header.timestamp, block.header)
                    }

                    // Borrow
                    if (topic === morphoBlue.events.Borrow.topic) {
                        const e = morphoBlue.events.Borrow.decode(log)
                        const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                        if (!market) continue
                        const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                        const loanPrice = await getTokenPriceInUsd(ctx, market.borrowedToken?.id ?? '', block.header)
                        await ctx.store.upsert(new Borrow({
                            id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                            hash: log.transaction?.hash ?? log.id, logIndex: log.logIndex,
                            protocol, account, market,
                            asset: market.borrowedToken,
                            amount: e.assets, amountUSD: calcUSD(e.assets, market.borrowedToken?.decimals ?? 18, loanPrice) as any,
                            shares: e.shares, onBehalf: e.onBehalf.toLowerCase(),
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                        }))

                        // Update BORROWER position
                        const posId = positionId(e.onBehalf.toLowerCase(), market.id, PositionSide.BORROWER)
                        let pos = await ctx.store.get(Position, posId)
                        if (!pos) {
                            pos = new Position({
                                id: posId, account, market,
                                side: PositionSide.BORROWER, isCollateral: false,
                                shares: 0n, balance: 0n, balanceUSD: BigInt(0) as any,
                                isActive: true,
                                timestampOpened: BigInt(block.header.timestamp),
                                blockNumberOpened: BigInt(block.header.height),
                            })
                            account.positionCount += 1
                            account.openPositionCount += 1
                            protocol.openPositionCount += 1
                            protocol.cumulativePositionCount += 1
                        } else {
                            reopenClosedPosition(pos, account, protocol)
                        }
                        pos.shares += e.shares
                        await ctx.store.upsert(account)

                        market.totalBorrowAssets += e.assets
                        market.totalBorrowShares += e.shares

                        // Debt accrues too — derive it from shares against post-event
                        // totals rather than summing borrowed amounts.
                        pos.balance = borrowerAssets(pos.shares, market)
                        pos.balanceUSD = calcUSD(pos.balance, market.borrowedToken?.decimals ?? 18, loanPrice) as any
                        await ctx.store.upsert(pos)

                        const borrowUSD = calcUSD(e.assets, market.borrowedToken?.decimals ?? 18, loanPrice)
                        market.cumulativeBorrowUSD = ((Number(market.cumulativeBorrowUSD) || 0) + borrowUSD) as any
                        protocol.cumulativeBorrowUSD = ((Number(protocol.cumulativeBorrowUSD) || 0) + borrowUSD) as any
                        await ctx.store.upsert(market)
                        await ctx.store.upsert(protocol)

                        await snapshotMarket(ctx, market, block.header.height, block.header.timestamp, block.header)
                    }

                    // Repay
                    if (topic === morphoBlue.events.Repay.topic) {
                        const e = morphoBlue.events.Repay.decode(log)
                        const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                        if (!market) continue
                        const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                        const loanPrice = await getTokenPriceInUsd(ctx, market.borrowedToken?.id ?? '', block.header)
                        await ctx.store.upsert(new Repay({
                            id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                            hash: log.transaction?.hash ?? log.id, logIndex: log.logIndex,
                            protocol, account, market,
                            asset: market.borrowedToken,
                            amount: e.assets, amountUSD: calcUSD(e.assets, market.borrowedToken?.decimals ?? 18, loanPrice) as any,
                            shares: e.shares, onBehalf: e.onBehalf.toLowerCase(),
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                        }))

                        // Update BORROWER position
                        const posId = positionId(e.onBehalf.toLowerCase(), market.id, PositionSide.BORROWER)
                        let pos = await ctx.store.get(Position, posId)

                        market.totalBorrowAssets -= e.assets
                        market.totalBorrowShares -= e.shares
                        await ctx.store.upsert(market)

                        if (pos) {
                            // Repaid assets include accrued interest; subtract shares.
                            pos.shares = floor0(pos.shares - e.shares)
                            pos.balance = borrowerAssets(pos.shares, market)
                            pos.balanceUSD = calcUSD(pos.balance, market.borrowedToken?.decimals ?? 18, loanPrice) as any
                            if (pos.shares <= 0n && pos.isActive) {
                                pos.isActive = false
                                pos.timestampClosed = BigInt(block.header.timestamp)
                                pos.blockNumberClosed = BigInt(block.header.height)
                                account.openPositionCount -= 1
                                account.closedPositionCount += 1
                                protocol.openPositionCount -= 1
                                await ctx.store.upsert(account)
                                await ctx.store.upsert(protocol)
                            }
                            await ctx.store.upsert(pos)
                        }

                        await snapshotMarket(ctx, market, block.header.height, block.header.timestamp, block.header)
                    }

                    // SupplyCollateral
                    if (topic === morphoBlue.events.SupplyCollateral.topic) {
                        const e = morphoBlue.events.SupplyCollateral.decode(log)
                        const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                        if (!market) continue
                        const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                        const posId = positionId(e.onBehalf.toLowerCase(), market.id, PositionSide.COLLATERAL)
                        const collateralPrice = await getTokenPriceInUsd(ctx, market.inputToken?.id ?? '', block.header)
                        let pos = await ctx.store.get(Position, posId)
                        if (!pos) {
                            pos = new Position({
                                id: posId, account, market,
                                side: PositionSide.COLLATERAL, isCollateral: true,
                                shares: 0n, balance: 0n, balanceUSD: BigInt(0) as any,
                                isActive: true,
                                timestampOpened: BigInt(block.header.timestamp),
                                blockNumberOpened: BigInt(block.header.height),
                            })
                            account.openPositionCount += 1
                            account.positionCount += 1
                            protocol.openPositionCount += 1
                            protocol.cumulativePositionCount += 1
                        } else {
                            reopenClosedPosition(pos, account, protocol)
                        }
                        pos.balance += e.assets
                        pos.balanceUSD = calcUSD(pos.balance, market.inputToken?.decimals ?? 18, collateralPrice) as any
                        await ctx.store.upsert(pos)
                        await ctx.store.upsert(account)
                        await ctx.store.upsert(protocol)
                    }

                    // WithdrawCollateral
                    if (topic === morphoBlue.events.WithdrawCollateral.topic) {
                        const e = morphoBlue.events.WithdrawCollateral.decode(log)
                        const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                        if (!market) continue
                        const posId = positionId(e.onBehalf.toLowerCase(), market.id, PositionSide.COLLATERAL)
                        const collateralPrice = await getTokenPriceInUsd(ctx, market.inputToken?.id ?? '', block.header)
                        const pos = await ctx.store.get(Position, posId)
                        if (pos) {
                            // Collateral is genuinely asset-denominated and does not
                            // accrue, so subtracting assets is correct here.
                            pos.balance = floor0(pos.balance - e.assets)
                            pos.balanceUSD = calcUSD(pos.balance, market.inputToken?.decimals ?? 18, collateralPrice) as any
                            if (pos.balance <= 0n && pos.isActive) {
                                pos.isActive = false
                                pos.timestampClosed = BigInt(block.header.timestamp)
                                pos.blockNumberClosed = BigInt(block.header.height)
                                const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())
                                account.openPositionCount -= 1
                                account.closedPositionCount += 1
                                protocol.openPositionCount -= 1
                                await ctx.store.upsert(account)
                                await ctx.store.upsert(protocol)
                            }
                            await ctx.store.upsert(pos)
                        }
                    }

                    // Liquidate
                    if (topic === morphoBlue.events.Liquidate.topic) {
                        const e = morphoBlue.events.Liquidate.decode(log)
                        const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                        if (!market) continue
                        const liquidator = await getOrCreateAccount(ctx, (e.caller ?? log.transaction?.from ?? '').toLowerCase())
                        const liquidatee = await getOrCreateAccount(ctx, e.borrower.toLowerCase())

                        const loanPrice = await getTokenPriceInUsd(ctx, market.borrowedToken?.id ?? '', block.header)
                        const collateralPrice = await getTokenPriceInUsd(ctx, market.inputToken?.id ?? '', block.header)
                        const repaidUSD = calcUSD(e.repaidAssets, market.borrowedToken?.decimals ?? 18, loanPrice)
                        const seizedUSD = calcUSD(e.seizedAssets, market.inputToken?.decimals ?? 18, collateralPrice)

                        await ctx.store.upsert(new Liquidate({
                            id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                            hash: log.transaction?.hash ?? log.id, logIndex: log.logIndex,
                            protocol, liquidator, liquidatee, market,
                            asset: market.borrowedToken,
                            amount: e.repaidAssets, amountUSD: repaidUSD as any, profitUSD: (seizedUSD - repaidUSD) as any,
                            seizedAsset: market.inputToken,
                            seizedAmount: e.seizedAssets, seizedAmountUSD: seizedUSD as any,
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                        }))

                        // Apply the liquidation to market totals first, so the share
                        // price used below reflects post-event state. Bad debt is
                        // written off the borrower and socialised to suppliers, which
                        // the previous code did not account for at all.
                        market.totalBorrowAssets -= (e.repaidAssets + e.badDebtAssets)
                        market.totalBorrowShares -= (e.repaidShares + e.badDebtShares)
                        market.totalSupplyAssets -= e.badDebtAssets

                        // Update BORROWER position for the liquidatee
                        const posId = positionId(e.borrower.toLowerCase(), market.id, PositionSide.BORROWER)
                        let pos = await ctx.store.get(Position, posId)
                        if (pos) {
                            pos.shares = floor0(pos.shares - e.repaidShares - e.badDebtShares)
                            pos.balance = borrowerAssets(pos.shares, market)
                            pos.balanceUSD = calcUSD(pos.balance, market.borrowedToken?.decimals ?? 18, loanPrice) as any
                            if (pos.shares <= 0n && pos.isActive) {
                                pos.isActive = false
                                pos.timestampClosed = BigInt(block.header.timestamp)
                                pos.blockNumberClosed = BigInt(block.header.height)
                                liquidatee.openPositionCount -= 1
                                liquidatee.closedPositionCount += 1
                                protocol.openPositionCount -= 1
                                await ctx.store.upsert(liquidatee)
                                await ctx.store.upsert(protocol)
                            }
                            await ctx.store.upsert(pos)
                        }

                        // Update COLLATERAL position for the liquidatee (seized collateral)
                        const collPosId = positionId(e.borrower.toLowerCase(), market.id, PositionSide.COLLATERAL)
                        let collPos = await ctx.store.get(Position, collPosId)
                        if (collPos) {
                            collPos.balance = floor0(collPos.balance - e.seizedAssets)
                            collPos.balanceUSD = calcUSD(collPos.balance, market.inputToken?.decimals ?? 18, collateralPrice) as any
                            if (collPos.balance <= 0n && collPos.isActive) {
                                collPos.isActive = false
                                collPos.timestampClosed = BigInt(block.header.timestamp)
                                collPos.blockNumberClosed = BigInt(block.header.height)
                                liquidatee.openPositionCount -= 1
                                liquidatee.closedPositionCount += 1
                                protocol.openPositionCount -= 1
                                await ctx.store.upsert(liquidatee)
                                await ctx.store.upsert(protocol)
                            }
                            await ctx.store.upsert(collPos)
                        }

                        market.cumulativeLiquidateUSD = ((Number(market.cumulativeLiquidateUSD) || 0) + repaidUSD) as any
                        protocol.cumulativeLiquidateUSD = ((Number(protocol.cumulativeLiquidateUSD) || 0) + repaidUSD) as any
                        await ctx.store.upsert(market)

                        await snapshotMarket(ctx, market, block.header.height, block.header.timestamp, block.header)
                    }

                    // AccrueInterest — update borrow rate AND compute APYs
                    if (topic === morphoBlue.events.AccrueInterest.topic) {
                        const e = morphoBlue.events.AccrueInterest.decode(log)
                        const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                        if (!market) continue

                        market.totalBorrowAssets += e.interest
                        market.totalSupplyAssets += e.interest
                        // Morpho mints feeShares to the fee recipient on accrual.
                        // Leaving them out understates totalSupplyShares, which
                        // inflates the share price and would overstate every
                        // position's derived asset value.
                        market.totalSupplyShares += e.feeShares
                        market.lastUpdate = BigInt(block.header.timestamp)

                        // prevBorrowRate is the per-second borrow rate (WAD-scaled)
                        const borrowRateId = `${e.id}-${InterestRateSide.BORROWER}`
                        const borrowRate = await ctx.store.get(InterestRate, borrowRateId)
                        if (borrowRate) {
                            borrowRate.rate = e.prevBorrowRate as any
                            await ctx.store.upsert(borrowRate)
                        }

                        // Compute borrowAPY: annualise the per-second rate
                        const borrowAPYRaw = annualisedAPY(e.prevBorrowRate)
                        market.borrowAPY = borrowAPYRaw as any

                        // Derive lender rate & supply APY
                        const lenderRateId = `${e.id}-${InterestRateSide.LENDER}`
                        const lenderRate = await ctx.store.get(InterestRate, lenderRateId)
                        if (market.totalSupplyAssets > 0n) {
                            const utilization = (market.totalBorrowAssets * WAD) / market.totalSupplyAssets
                            const feeFactor = WAD - market.fee
                            const lendRateRaw = (e.prevBorrowRate * utilization * feeFactor) / WAD / WAD
                            if (lenderRate) {
                                lenderRate.rate = lendRateRaw as any
                                await ctx.store.upsert(lenderRate)
                            }
                            // supplyAPY = annualise the lender rate
                            market.supplyAPY = annualisedAPY(lendRateRaw) as any
                        }

                        await ctx.store.upsert(market)
                        await snapshotMarket(ctx, market, block.header.height, block.header.timestamp, block.header)

                        // Accrual changes this market's share price, so every vault
                        // allocated to it is now worth more. Without this the vault's
                        // totalAssets only moved on its own deposit/withdraw events
                        // and drifted below chain by the interest earned in between.
                        // Zero-interest accruals (blocks in the same second) change no
                        // share price — skip the fan-out entirely.
                        if (e.interest > 0n || e.feeShares > 0n) {
                            await propagateAccrualToVaults(ctx, market, block.header)
                        }
                    }
                }

                // ══════════════════════════════════════════
                // PUBLIC ALLOCATOR
                // ══════════════════════════════════════════

                if (PUBLIC_ALLOCATOR && addr === PUBLIC_ALLOCATOR) {
                    try {
                        const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))

                        // SetFlowCaps — authoritative reset of the caps for a batch
                        // of (vault, market) pairs.
                        if (topic === publicAllocatorAbi.events.SetFlowCaps.topic) {
                            const e = publicAllocatorAbi.events.SetFlowCaps.decode(log)
                            const vaultAddr = e.vault.toLowerCase()
                            const vault = await ctx.store.get(MetaMorphoEntity, vaultAddr)
                            if (!vault) continue
                            for (const cfg of e.config) {
                                const market = await ctx.store.get(Market, cfg.id)
                                if (!market) continue
                                await ctx.store.upsert(new PublicAllocatorFlowCap({
                                    id: `${vaultAddr}-${cfg.id}`,
                                    vault, market,
                                    maxIn: cfg.caps.maxIn,
                                    maxOut: cfg.caps.maxOut,
                                    lastUpdate: nowSec,
                                }))
                            }
                        }

                        // Each public reallocation shifts remaining capacity, exactly
                        // as PublicAllocator.reallocateTo does on-chain: pulling out of
                        // a market spends maxOut and refunds maxIn, and vice versa.
                        if (topic === publicAllocatorAbi.events.PublicWithdrawal.topic) {
                            const e = publicAllocatorAbi.events.PublicWithdrawal.decode(log)
                            await adjustFlowCap(ctx, e.vault.toLowerCase(), e.withdrawnMarketId,
                                e.withdrawnAssets, -e.withdrawnAssets, nowSec)
                        }

                        if (topic === publicAllocatorAbi.events.PublicReallocateTo.topic) {
                            const e = publicAllocatorAbi.events.PublicReallocateTo.decode(log)
                            await adjustFlowCap(ctx, e.vault.toLowerCase(), e.supplyMarketId,
                                -e.suppliedAssets, e.suppliedAssets, nowSec)
                        }
                    } catch (err: any) {
                        ctx.log.error({ err, tx: log.transaction?.hash, addr }, `Error processing PublicAllocator event`)
                    }
                    continue
                }

                // ══════════════════════════════════════════
                // METAMORPHO & VAULT V2 EVENTS
                // ══════════════════════════════════════════

                if (addr === MORPHO_BLUE) continue;

                const vaultType = await identifyVault(ctx, addr, block.header);

                if (vaultType === VaultType.MetaMorpho) {
                    try {
                        const isMetaMorphoTopic =
                            topic === metaMorpho.events.Deposit.topic ||
                            topic === metaMorpho.events.Withdraw.topic ||
                            topic === metaMorpho.events.SetCap.topic ||
                            topic === metaMorpho.events.UpdateLastTotalAssets.topic ||
                            // Role/fee changes. Without these the values stay
                            // frozen at whatever they were when the vault was
                            // first seen — and a stale `fee` silently inflates
                            // the net supply APY the gateway reports.
                            topic === metaMorpho.events.SetGuardian.topic ||
                            topic === metaMorpho.events.SetFee.topic ||
                            topic === metaMorpho.events.SetCurator.topic;

                        if (!isMetaMorphoTopic) continue;

                        let vault = await getOrCreateMetaMorpho(ctx, addr, block.header)
                        if (!vault) continue;

                        if (topic === metaMorpho.events.SetGuardian.topic) {
                            const e = metaMorpho.events.SetGuardian.decode(log)
                            vault.guardian = e.guardian.toLowerCase()
                            await ctx.store.upsert(vault)
                            continue
                        }

                        if (topic === metaMorpho.events.SetFee.topic) {
                            const e = metaMorpho.events.SetFee.decode(log)
                            vault.fee = BigInt(e.newFee)
                            await ctx.store.upsert(vault)
                            continue
                        }

                        if (topic === metaMorpho.events.SetCurator.topic) {
                            const e = metaMorpho.events.SetCurator.decode(log)
                            vault.curator = await getOrCreateAccount(ctx, e.newCurator.toLowerCase())
                            await ctx.store.upsert(vault)
                            continue
                        }

                        if (topic === metaMorpho.events.Deposit.topic) {
                            const e = metaMorpho.events.Deposit.decode(log)

                            const sender = await getOrCreateAccount(ctx, e.sender.toLowerCase())
                            const owner = await getOrCreateAccount(ctx, e.owner.toLowerCase())

                            await ctx.store.upsert(new MetaMorphoDeposit({
                                id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                                vault, sender, owner,
                                assets: e.assets, shares: e.shares,
                                blockNumber: BigInt(block.header.height),
                                timestamp: BigInt(block.header.timestamp),
                                hash: log.transaction?.hash ?? log.id,
                            }))

                            // Update vault position
                            const posId = `${addr}-${e.owner.toLowerCase()}`
                            let pos = await ctx.store.get(MetaMorphoPosition, posId)
                            if (!pos) {
                                pos = new MetaMorphoPosition({
                                    id: posId, vault,
                                    account: owner,
                                    shares: 0n, assets: 0n,
                                })
                            }
                            pos.shares += e.shares

                            const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                            await updateVaultState(ctx, vault, nowSec, vault.totalSupply + e.shares, vault.totalAssets + e.assets, false, block.header);

                            // Derive after the vault totals update, so the share price
                            // is post-event. Summing e.assets here tracked principal
                            // only and drifted below the holder's real balance.
                            pos.assets = shareholderAssets(pos.shares, vault)
                            await ctx.store.upsert(pos)
                            await ctx.store.upsert(vault)

                            await snapshotMetaMorpho(ctx, vault, block.header.height, block.header.timestamp)
                        }

                        if (topic === metaMorpho.events.Withdraw.topic) {
                            const e = metaMorpho.events.Withdraw.decode(log)

                            const sender = await getOrCreateAccount(ctx, e.sender.toLowerCase())
                            const owner = await getOrCreateAccount(ctx, e.owner.toLowerCase())

                            await ctx.store.upsert(new MetaMorphoWithdraw({
                                id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                                vault, sender, receiver: e.receiver.toLowerCase(), owner,
                                assets: e.assets, shares: e.shares,
                                blockNumber: BigInt(block.header.height),
                                timestamp: BigInt(block.header.timestamp),
                                hash: log.transaction?.hash ?? log.id,
                            }))

                            const posId = `${addr}-${e.owner.toLowerCase()}`
                            let pos = await ctx.store.get(MetaMorphoPosition, posId)

                            const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                            await updateVaultState(ctx, vault, nowSec, vault.totalSupply - e.shares, vault.totalAssets - e.assets, false, block.header);

                            if (pos) {
                                // Withdrawn assets include yield, so subtracting them
                                // from a principal sum drives the holder negative on a
                                // full exit — the same defect as the market positions.
                                pos.shares = floor0(pos.shares - e.shares)
                                pos.assets = shareholderAssets(pos.shares, vault)
                                await ctx.store.upsert(pos)
                            }

                            await ctx.store.upsert(vault)

                            await snapshotMetaMorpho(ctx, vault, block.header.height, block.header.timestamp)
                        }

                        // SetCap — track market allocations in vault's supplyQueue
                        if (topic === metaMorpho.events.SetCap.topic) {
                            const e = metaMorpho.events.SetCap.decode(log)

                            const market = await ctx.store.get(Market, { where: { id: e.id }, relations: { borrowedToken: true, inputToken: true } })
                            if (!market) continue
                            const allocId = `${vault.id}-${e.id}`
                            let alloc = await ctx.store.get(MetaMorphoMarketAllocation, allocId)
                            if (!alloc) {
                                alloc = new MetaMorphoMarketAllocation({ id: allocId, vault, market, cap: 0n, enabled: false })
                            }
                            alloc.cap = e.cap
                            alloc.enabled = e.cap > 0n
                            await ctx.store.upsert(alloc)
                        }

                        // UpdateLastTotalAssets — use the authoritative totalAssets from the event
                        if (topic === metaMorpho.events.UpdateLastTotalAssets.topic) {
                            const e = metaMorpho.events.UpdateLastTotalAssets.decode(log)

                            const newTotalAssets = e.updatedTotalAssets
                            const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                            await updateVaultState(ctx, vault, nowSec, vault.totalSupply, newTotalAssets, false, block.header);

                            await ctx.store.upsert(vault)

                            await snapshotMetaMorpho(ctx, vault, block.header.height, block.header.timestamp)
                        }

                    } catch (err: any) {
                        ctx.log.error({ err, tx: log.transaction?.hash, addr }, `Error processing MetaMorpho event`)
                    }
                } else if (vaultType === VaultType.VaultV2) {
                    try {
                        const vaultAddr = addr

                        // ERC4626 Deposit
                        if (topic === vaultV2Abi.events.Deposit.topic) {
                            const e = vaultV2Abi.events.Deposit.decode(log)
                            let vault = await getOrCreateVaultV2(ctx, vaultAddr, block.header)
                            if (!vault) continue
                            const sender = await getOrCreateAccount(ctx, e.sender.toLowerCase())
                            const owner = await getOrCreateAccount(ctx, e.owner.toLowerCase())

                            await ctx.store.upsert(new VaultV2Deposit({
                                id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                                vault, sender, owner,
                                assets: e.assets, shares: e.shares,
                                blockNumber: BigInt(block.header.height),
                                timestamp: BigInt(block.header.timestamp),
                                hash: log.transaction?.hash ?? log.id,
                            }))

                            const posId = `${vaultAddr}-${e.owner.toLowerCase()}`
                            let pos = await ctx.store.get(VaultV2Position, posId)
                            if (!pos) {
                                pos = new VaultV2Position({ id: posId, vault, account: owner, shares: 0n, assets: 0n })
                            }
                            pos.shares += e.shares

                            // Prefer chain truth over arithmetic: the running sum only
                            // tracks principal and silently diverges from NAV.
                            const state = await readVaultV2State(ctx, block.header, vaultAddr)
                            const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                            await updateVaultState(
                                ctx, vault, nowSec,
                                state?.totalSupply ?? vault.totalSupply + e.shares,
                                state?.totalAssets ?? vault.totalAssets + e.assets,
                                true, block.header,
                            );

                            pos.assets = shareholderAssets(pos.shares, vault)
                            await ctx.store.upsert(pos)
                            await ctx.store.upsert(vault)

                            await snapshotVaultV2(ctx, vault, block.header.height, block.header.timestamp)
                        }

                        // ERC4626 Withdraw
                        if (topic === vaultV2Abi.events.Withdraw.topic) {
                            const e = vaultV2Abi.events.Withdraw.decode(log)
                            let vault = await getOrCreateVaultV2(ctx, vaultAddr, block.header)
                            if (!vault) continue
                            const sender = await getOrCreateAccount(ctx, e.sender.toLowerCase())
                            const owner = await getOrCreateAccount(ctx, e.owner.toLowerCase())

                            await ctx.store.upsert(new VaultV2Withdraw({
                                id: eventId(log.transaction?.hash ?? log.id, log.logIndex),
                                vault, sender, receiver: e.receiver.toLowerCase(), owner,
                                assets: e.assets, shares: e.shares,
                                blockNumber: BigInt(block.header.height),
                                timestamp: BigInt(block.header.timestamp),
                                hash: log.transaction?.hash ?? log.id,
                            }))

                            const posId = `${vaultAddr}-${e.owner.toLowerCase()}`
                            let pos = await ctx.store.get(VaultV2Position, posId)

                            const state = await readVaultV2State(ctx, block.header, vaultAddr)
                            const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                            await updateVaultState(
                                ctx, vault, nowSec,
                                state?.totalSupply ?? vault.totalSupply - e.shares,
                                state?.totalAssets ?? vault.totalAssets - e.assets,
                                true, block.header,
                            );

                            if (pos) {
                                // Shares are the source of truth; assets are that
                                // share of the freshly-read NAV.
                                pos.shares = floor0(pos.shares - e.shares)
                                pos.assets = shareholderAssets(pos.shares, vault)
                                await ctx.store.upsert(pos)
                            }

                            await ctx.store.upsert(vault)

                            await snapshotVaultV2(ctx, vault, block.header.height, block.header.timestamp)
                        }

                        // IncreaseAbsoluteCap — track allocation caps per (vault, id)
                        if (topic === vaultV2Abi.events.IncreaseAbsoluteCap.topic) {
                            const e = vaultV2Abi.events.IncreaseAbsoluteCap.decode(log)
                            const vault = await getOrCreateVaultV2(ctx, vaultAddr, block.header)
                            if (!vault) continue
                            const allocId = `${vaultAddr}-${e.id}`
                            let alloc = await ctx.store.get(VaultV2Allocation, allocId)
                            if (!alloc) {
                                alloc = new VaultV2Allocation({
                                    id: allocId, vault,
                                    adapter: '', marketId: e.id,
                                    absoluteCap: 0n, relativeCap: 0n,
                                })
                            }
                            alloc.absoluteCap = e.newAbsoluteCap
                            await ctx.store.upsert(alloc)
                        }

                        if (topic === vaultV2Abi.events.DecreaseAbsoluteCap.topic) {
                            const e = vaultV2Abi.events.DecreaseAbsoluteCap.decode(log)
                            const vault = await getOrCreateVaultV2(ctx, vaultAddr, block.header)
                            if (!vault) continue
                            const allocId = `${vaultAddr}-${e.id}`
                            const alloc = await ctx.store.get(VaultV2Allocation, allocId)
                            if (alloc) {
                                alloc.absoluteCap = e.newAbsoluteCap
                                await ctx.store.upsert(alloc)
                            }
                        }

                        if (topic === vaultV2Abi.events.IncreaseRelativeCap.topic) {
                            const e = vaultV2Abi.events.IncreaseRelativeCap.decode(log)
                            const vault = await getOrCreateVaultV2(ctx, vaultAddr, block.header)
                            if (!vault) continue
                            const allocId = `${vaultAddr}-${e.id}`
                            let alloc = await ctx.store.get(VaultV2Allocation, allocId)
                            if (!alloc) {
                                alloc = new VaultV2Allocation({
                                    id: allocId, vault,
                                    adapter: '', marketId: e.id,
                                    absoluteCap: 0n, relativeCap: 0n,
                                })
                            }
                            alloc.relativeCap = e.newRelativeCap
                            await ctx.store.upsert(alloc)
                        }

                        if (topic === vaultV2Abi.events.Allocate.topic) {
                            const e = vaultV2Abi.events.Allocate.decode(log)
                            const vault = await getOrCreateVaultV2(ctx, vaultAddr, block.header)
                            if (!vault) continue
                            const allocId = `${vaultAddr}-${e.ids}`
                            let alloc = await ctx.store.get(VaultV2Allocation, allocId)
                            if (!alloc) {
                                alloc = new VaultV2Allocation({
                                    id: allocId, vault,
                                    adapter: e.adapter.toLowerCase(), marketId: e.ids,
                                    absoluteCap: 0n, relativeCap: 0n,
                                })
                            } else {
                                // Update adapter if previously empty (from early cap events)
                                alloc.adapter = e.adapter.toLowerCase()
                            }
                            await ctx.store.upsert(alloc)
                        }

                        if (topic === vaultV2Abi.events.Deallocate.topic) {
                            const e = vaultV2Abi.events.Deallocate.decode(log)
                            const vault = await getOrCreateVaultV2(ctx, vaultAddr, block.header)
                            if (!vault) continue
                            const allocId = `${vaultAddr}-${e.ids}`
                            let alloc = await ctx.store.get(VaultV2Allocation, allocId)
                            if (!alloc) {
                                alloc = new VaultV2Allocation({
                                    id: allocId, vault,
                                    adapter: e.adapter.toLowerCase(), marketId: e.ids,
                                    absoluteCap: 0n, relativeCap: 0n,
                                })
                            } else {
                                alloc.adapter = e.adapter.toLowerCase()
                            }
                            await ctx.store.upsert(alloc)
                        }
                    } catch (err) {
                        ctx.log.error({ err, tx: log.transaction?.hash, addr }, `Error processing VaultV2 event`)
                    }
                }
            }
        }
    }

    /**
     * Portal ingestion. Portal serves finalized data only — evm-stream has no
     * RPC-backed hot-block path — so hot blocks are off and the tip lags by the
     * chain's finality depth instead of being served optimistically then rolled back.
     */
    if (USE_PORTAL) {
        run(dataSource, new TypeormDatabase({ supportHotBlocks: false }), async (rawCtx: any) => {
            const ctx = {
                ...rawCtx,
                blocks: rawCtx.blocks.map((block: any) => {
                    const b: any = augmentBlock(block)
                    // evm-stream already reports ms, matching EvmBatchProcessor;
                    // the raw portal API returns seconds. Guard against ingesting
                    // a seconds value, since getDayId/getHourId, the nowSec
                    // divisions and every row already written assume ms.
                    if (b.header.timestamp != null && b.header.timestamp < 1e11) {
                        b.header.timestamp = b.header.timestamp * 1000
                    }
                    return b
                }),
                log: mappingLogger,
                // @subsquid/evm-abi's Contract wants `_chain.client.call(method, params)`.
                // EvmBatchProcessor injects this itself; the portal data source has
                // no RPC at all, so supply one here — the mapping does ~10 kinds of
                // contract read (ERC20 metadata, vault probing, feeds, oracles).
                _chain: { client: rpcClient },
            }

            // These must run on BOTH ingestion paths. They were originally wired
            // only into the RPC branch below, which is Citrea-only — so on every
            // portal network (Plume, Flare, Berachain) guardian/fee stayed unset
            // and position shares were never restored after the migration zeroed
            // them, leaving vault liquidity at 0 with no error anywhere.
            await backfillVaultRoles(ctx)
            await backfillPositionShares(ctx)
            await repairVaultAssets(ctx)
            await handleBatch(ctx)
            await refreshVaultV2State(ctx)
        })
    } else {
        // Networks the portal has no dataset for (Citrea). EvmBatchProcessor
        // already provides log, store, _chain and millisecond timestamps, so the
        // ctx needs no augmentation — and it keeps hot-block support.
        processor.run(new TypeormDatabase({ supportHotBlocks: true }), async (ctx: any) => {
            await backfillVaultRoles(ctx)
            await backfillPositionShares(ctx)
            await repairVaultAssets(ctx)
            await handleBatch(ctx)
            // After the batch, so it reconciles against post-batch state rather
            // than being immediately overwritten by it.
            await refreshVaultV2State(ctx)
        })
    }

} // end of !CANTON branch