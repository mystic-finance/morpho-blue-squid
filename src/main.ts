import { TypeormDatabase } from '@subsquid/typeorm-store'
import { processor, MORPHO_BLUE } from './processor'
import * as morphoBlue from './abi/MorphoBlue'
import * as metaMorpho from './abi/MetaMorpho'
import * as erc20Abi from './abi/ERC20'
import {
    LendingProtocol, Market, Token, Account, Position, InterestRate,
    Deposit, Withdraw, Borrow, Repay, Liquidate,
    MetaMorpho as MetaMorphoEntity, MetaMorphoPosition, MetaMorphoDeposit, MetaMorphoWithdraw,
    MetaMorphoMarketAllocation, MetaMorphoMarketWithdrawAllocation,
    PositionSide, InterestRateSide, InterestRateType,
    MarketDailySnapshot, MarketHourlySnapshot,
    MetaMorphoDailySnapshot, MetaMorphoHourlySnapshot,
} from './model'
import { DataHandlerContext, BlockHeader } from '@subsquid/evm-processor'
import { Store } from '@subsquid/typeorm-store'
import { In } from 'typeorm'
import * as vaultV2Abi from './abi/VaultV2'
import {
    VaultV2, VaultV2Position, VaultV2Deposit, VaultV2Withdraw, VaultV2Allocation,
    VaultV2DailySnapshot, VaultV2HourlySnapshot,
} from './model'


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
        // 1. Mandatory Morpho check: must have curator (reverts if not a Morpho vault)
        await contract.curator()

        // 2. Check for MORPHO()
        try {
            await contract.MORPHO()
            vaultTypeCache.set(addr, VaultType.MetaMorpho)
            return VaultType.MetaMorpho
        } catch { }

        // 3. Check for adapterRegistry() using VaultV2 ABI
        const v2Contract = new vaultV2Abi.Contract(ctx, blockHeader, addr)
        try {
            await v2Contract.adapterRegistry()
            vaultTypeCache.set(addr, VaultType.VaultV2)
            return VaultType.VaultV2
        } catch { }

    } catch {
        // Doesn't have curator, or call reverted (not a morpho vault)
    }

    vaultTypeCache.set(addr, VaultType.Unknown)
    return VaultType.Unknown
}

// ---- Helpers ----

function positionId(account: string, market: string, side: PositionSide) {
    return `${account}-${market}-${side}`
}

function eventId(txHash: string, logIndex: number) {
    return `${txHash}-${logIndex}`
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

async function computeVaultAPY(ctx: DataHandlerContext<Store>, vaultId: string): Promise<number> {
    const vaultPositions = await ctx.store.find(Position, {
        where: { account: { id: vaultId }, side: PositionSide.LENDER },
        relations: { market: { borrowedToken: true } }
    });

    let totalAssets = 0;
    let weightedApySum = 0;

    for (const pos of vaultPositions) {
        const market = pos.market;
        if (!market || pos.balance <= 0n || market.totalSupplyShares <= 0n) continue;

        const assetsBase = (pos.balance * market.totalSupplyAssets) / market.totalSupplyShares;
        const decimals = market.borrowedToken?.decimals ?? 18;
        const assets = Number(assetsBase) / (10 ** decimals);
        const mktApy = Number(market.supplyAPY) || 0;

        weightedApySum += assets * mktApy;
        totalAssets += assets;
    }

    return totalAssets > 0 ? weightedApySum / totalAssets : 0;
}

async function updateVaultState(
    ctx: DataHandlerContext<Store>,
    vault: { id: string, totalSupply: bigint, totalAssets: bigint, lastTotalAssetsTimestamp: bigint, lastTotalAssets: bigint, apy: any },
    nowSec: bigint,
    newTotalSupply: bigint,
    newTotalAssets: bigint
) {
    // Compute weighted APY from underlying market allocations
    vault.apy = await computeVaultAPY(ctx, vault.id) as any;

    vault.lastTotalAssets = vault.totalAssets;
    vault.lastTotalAssetsTimestamp = nowSec;
    vault.totalSupply = newTotalSupply;
    vault.totalAssets = newTotalAssets;
}

async function getOrCreateToken(ctx: DataHandlerContext<Store>, address: string): Promise<Token> {
    let token = await ctx.store.get(Token, address)
    if (!token) {
        // Try to fetch real token metadata via ERC20 RPC calls
        let name = address.slice(0, 8)
        let symbol = '???'
        let decimals = 18
        try {
            const contract = new erc20Abi.Contract(ctx, ctx.blocks[0]?.header ?? ({} as any), address)
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
    let vault = await ctx.store.get(MetaMorphoEntity, addr)
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

        const assetToken = await getOrCreateToken(ctx, assetAddr.toLowerCase())
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
        await ctx.store.upsert(vault)
        ctx.log.info(`Created MetaMorpho vault: ${addr} (${name})`)
        return vault
    } catch (err) {
        // Not a MetaMorpho vault — silently skip
        ctx.log.warn(`Could not create MetaMorpho vault for ${addr}: ${err}`)
        return null
    }
}

async function getOrCreateVaultV2(
    ctx: DataHandlerContext<Store>,
    address: string,
    blockHeader: BlockHeader
): Promise<VaultV2 | null> {
    const addr = address.toLowerCase()
    let vault = await ctx.store.get(VaultV2, addr)
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

        const assetToken = await getOrCreateToken(ctx, assetAddr.toLowerCase())
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
            totalAssets: 0n,
            totalSupply: 0n,
            totalAssetsUSD: BigInt(0) as any,
            apy: BigInt(0) as any,
            lastTotalAssets: 0n,
            lastTotalAssetsTimestamp: 0n,
        })
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

async function snapshotMarket(
    ctx: DataHandlerContext<Store>,
    market: Market,
    blockHeight: number,
    timestampMs: number
): Promise<void> {
    const dayId = getDayId(timestampMs)
    const hourId = getHourId(timestampMs)

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

processor.run(new TypeormDatabase({ supportHotBlocks: true }), async (ctx) => {
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
                    const collateralToken = await getOrCreateToken(ctx, marketParams.collateralToken)
                    const loanToken = await getOrCreateToken(ctx, marketParams.loanToken)
                    const lltv = marketParams.lltv
                    const liquidationThreshold = Number(lltv) / 1e18

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
                        maximumLTV: BigInt(0) as any,
                        liquidationThreshold: BigInt(0) as any,
                        liquidationPenalty: BigInt(0) as any,
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
                    await snapshotMarket(ctx, market, block.header.height, block.header.timestamp)
                }

                // Supply (lend)
                if (topic === morphoBlue.events.Supply.topic) {
                    const e = morphoBlue.events.Supply.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue
                    const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                    await ctx.store.insert(new Deposit({
                        id: eventId(log.transaction!.hash, log.logIndex),
                        hash: log.transaction!.hash,
                        logIndex: log.logIndex,
                        protocol,
                        account,
                        market,
                        asset: market.borrowedToken,
                        amount: e.assets,
                        amountUSD: BigInt(0) as any,
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
                            balance: 0n, balanceUSD: BigInt(0) as any,
                            isActive: true,
                            timestampOpened: BigInt(block.header.timestamp),
                            blockNumberOpened: BigInt(block.header.height),
                        })
                        account.positionCount += 1
                        account.openPositionCount += 1
                        protocol.openPositionCount += 1
                        protocol.cumulativePositionCount += 1
                    }
                    pos.balance += e.shares
                    await ctx.store.upsert(pos)
                    await ctx.store.upsert(account)

                    // Update market totals
                    market.totalSupplyAssets += e.assets
                    market.totalSupplyShares += e.shares
                    await ctx.store.upsert(market)
                    await ctx.store.upsert(protocol)

                    await snapshotMarket(ctx, market, block.header.height, block.header.timestamp)
                }

                // Withdraw (lender withdraws)
                if (topic === morphoBlue.events.Withdraw.topic) {
                    const e = morphoBlue.events.Withdraw.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue
                    const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                    await ctx.store.insert(new Withdraw({
                        id: eventId(log.transaction!.hash, log.logIndex),
                        hash: log.transaction!.hash, logIndex: log.logIndex,
                        protocol, account, market,
                        asset: market.borrowedToken,
                        amount: e.assets, amountUSD: BigInt(0) as any,
                        shares: e.shares, onBehalf: e.onBehalf.toLowerCase(),
                        blockNumber: BigInt(block.header.height),
                        timestamp: BigInt(block.header.timestamp),
                    }))

                    market.totalSupplyAssets -= e.assets
                    market.totalSupplyShares -= e.shares
                    await ctx.store.upsert(market)

                    await snapshotMarket(ctx, market, block.header.height, block.header.timestamp)
                }

                // Borrow
                if (topic === morphoBlue.events.Borrow.topic) {
                    const e = morphoBlue.events.Borrow.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue
                    const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                    await ctx.store.insert(new Borrow({
                        id: eventId(log.transaction!.hash, log.logIndex),
                        hash: log.transaction!.hash, logIndex: log.logIndex,
                        protocol, account, market,
                        asset: market.borrowedToken,
                        amount: e.assets, amountUSD: BigInt(0) as any,
                        shares: e.shares, onBehalf: e.onBehalf.toLowerCase(),
                        blockNumber: BigInt(block.header.height),
                        timestamp: BigInt(block.header.timestamp),
                    }))

                    market.totalBorrowAssets += e.assets
                    market.totalBorrowShares += e.shares
                    await ctx.store.upsert(market)

                    await snapshotMarket(ctx, market, block.header.height, block.header.timestamp)
                }

                // Repay
                if (topic === morphoBlue.events.Repay.topic) {
                    const e = morphoBlue.events.Repay.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue
                    const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                    await ctx.store.insert(new Repay({
                        id: eventId(log.transaction!.hash, log.logIndex),
                        hash: log.transaction!.hash, logIndex: log.logIndex,
                        protocol, account, market,
                        asset: market.borrowedToken,
                        amount: e.assets, amountUSD: BigInt(0) as any,
                        shares: e.shares, onBehalf: e.onBehalf.toLowerCase(),
                        blockNumber: BigInt(block.header.height),
                        timestamp: BigInt(block.header.timestamp),
                    }))

                    market.totalBorrowAssets -= e.assets
                    market.totalBorrowShares -= e.shares
                    await ctx.store.upsert(market)

                    await snapshotMarket(ctx, market, block.header.height, block.header.timestamp)
                }

                // SupplyCollateral
                if (topic === morphoBlue.events.SupplyCollateral.topic) {
                    const e = morphoBlue.events.SupplyCollateral.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue
                    const account = await getOrCreateAccount(ctx, e.onBehalf.toLowerCase())

                    const posId = positionId(e.onBehalf.toLowerCase(), market.id, PositionSide.COLLATERAL)
                    let pos = await ctx.store.get(Position, posId)
                    if (!pos) {
                        pos = new Position({
                            id: posId, account, market,
                            side: PositionSide.COLLATERAL, isCollateral: true,
                            balance: 0n, balanceUSD: BigInt(0) as any,
                            isActive: true,
                            timestampOpened: BigInt(block.header.timestamp),
                            blockNumberOpened: BigInt(block.header.height),
                        })
                        account.openPositionCount += 1
                        account.positionCount += 1
                    }
                    pos.balance += e.assets
                    await ctx.store.upsert(pos)
                    await ctx.store.upsert(account)
                }

                // WithdrawCollateral
                if (topic === morphoBlue.events.WithdrawCollateral.topic) {
                    const e = morphoBlue.events.WithdrawCollateral.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue
                    const posId = positionId(e.onBehalf.toLowerCase(), market.id, PositionSide.COLLATERAL)
                    const pos = await ctx.store.get(Position, posId)
                    if (pos) {
                        pos.balance -= e.assets
                        if (pos.balance <= 0n) {
                            pos.isActive = false
                            pos.timestampClosed = BigInt(block.header.timestamp)
                            pos.blockNumberClosed = BigInt(block.header.height)
                        }
                        await ctx.store.upsert(pos)
                    }
                }

                // Liquidate
                if (topic === morphoBlue.events.Liquidate.topic) {
                    const e = morphoBlue.events.Liquidate.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue
                    const liquidator = await getOrCreateAccount(ctx, log.transaction!.from.toLowerCase())
                    const liquidatee = await getOrCreateAccount(ctx, e.borrower.toLowerCase())

                    await ctx.store.insert(new Liquidate({
                        id: eventId(log.transaction!.hash, log.logIndex),
                        hash: log.transaction!.hash, logIndex: log.logIndex,
                        protocol, liquidator, liquidatee, market,
                        asset: market.borrowedToken,
                        amount: e.repaidAssets, amountUSD: BigInt(0) as any, profitUSD: BigInt(0) as any,
                        seizedAsset: market.inputToken,
                        seizedAmount: e.seizedAssets, seizedAmountUSD: BigInt(0) as any,
                        blockNumber: BigInt(block.header.height),
                        timestamp: BigInt(block.header.timestamp),
                    }))

                    market.totalBorrowAssets -= e.repaidAssets
                    market.totalBorrowShares -= e.repaidShares
                    await ctx.store.upsert(market)

                    await snapshotMarket(ctx, market, block.header.height, block.header.timestamp)
                }

                // AccrueInterest — update borrow rate AND compute APYs
                if (topic === morphoBlue.events.AccrueInterest.topic) {
                    const e = morphoBlue.events.AccrueInterest.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue

                    market.totalBorrowAssets += e.interest
                    market.totalSupplyAssets += e.interest
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
                    await snapshotMarket(ctx, market, block.header.height, block.header.timestamp)
                }
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
                        topic === metaMorpho.events.UpdateLastTotalAssets.topic;

                    if (!isMetaMorphoTopic) continue;

                    let vault = await getOrCreateMetaMorpho(ctx, addr, block.header)
                    if (!vault) continue;

                    if (topic === metaMorpho.events.Deposit.topic) {
                        const e = metaMorpho.events.Deposit.decode(log)

                        const sender = await getOrCreateAccount(ctx, e.sender.toLowerCase())
                        const owner = await getOrCreateAccount(ctx, e.owner.toLowerCase())

                        await ctx.store.insert(new MetaMorphoDeposit({
                            id: eventId(log.transaction!.hash, log.logIndex),
                            vault, sender, owner,
                            assets: e.assets, shares: e.shares,
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                            hash: log.transaction!.hash,
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
                        pos.assets += e.assets

                        const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                        await updateVaultState(ctx, vault, nowSec, vault.totalSupply + e.shares, vault.totalAssets + e.assets);

                        await ctx.store.upsert(pos)
                        await ctx.store.upsert(vault)

                        await snapshotMetaMorpho(ctx, vault, block.header.height, block.header.timestamp)
                    }

                    if (topic === metaMorpho.events.Withdraw.topic) {
                        const e = metaMorpho.events.Withdraw.decode(log)

                        const sender = await getOrCreateAccount(ctx, e.sender.toLowerCase())
                        const owner = await getOrCreateAccount(ctx, e.owner.toLowerCase())

                        await ctx.store.insert(new MetaMorphoWithdraw({
                            id: eventId(log.transaction!.hash, log.logIndex),
                            vault, sender, receiver: e.receiver.toLowerCase(), owner,
                            assets: e.assets, shares: e.shares,
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                            hash: log.transaction!.hash,
                        }))

                        const posId = `${addr}-${e.owner.toLowerCase()}`
                        let pos = await ctx.store.get(MetaMorphoPosition, posId)
                        if (pos) {
                            pos.shares -= e.shares
                            pos.assets -= e.assets
                            await ctx.store.upsert(pos)
                        }

                        const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                        await updateVaultState(ctx, vault, nowSec, vault.totalSupply - e.shares, vault.totalAssets - e.assets);
                        await ctx.store.upsert(vault)

                        await snapshotMetaMorpho(ctx, vault, block.header.height, block.header.timestamp)
                    }

                    // SetCap — track market allocations in vault's supplyQueue
                    if (topic === metaMorpho.events.SetCap.topic) {
                        const e = metaMorpho.events.SetCap.decode(log)

                        const market = await ctx.store.get(Market, e.id)
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
                        await updateVaultState(ctx, vault, nowSec, vault.totalSupply, newTotalAssets);

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

                        await ctx.store.insert(new VaultV2Deposit({
                            id: eventId(log.transaction!.hash, log.logIndex),
                            vault, sender, owner,
                            assets: e.assets, shares: e.shares,
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                            hash: log.transaction!.hash,
                        }))

                        const posId = `${vaultAddr}-${e.owner.toLowerCase()}`
                        let pos = await ctx.store.get(VaultV2Position, posId)
                        if (!pos) {
                            pos = new VaultV2Position({ id: posId, vault, account: owner, shares: 0n, assets: 0n })
                        }
                        pos.shares += e.shares
                        pos.assets += e.assets

                        const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                        await updateVaultState(ctx, vault, nowSec, vault.totalSupply + e.shares, vault.totalAssets + e.assets);

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

                        await ctx.store.insert(new VaultV2Withdraw({
                            id: eventId(log.transaction!.hash, log.logIndex),
                            vault, sender, receiver: e.receiver.toLowerCase(), owner,
                            assets: e.assets, shares: e.shares,
                            blockNumber: BigInt(block.header.height),
                            timestamp: BigInt(block.header.timestamp),
                            hash: log.transaction!.hash,
                        }))

                        const posId = `${vaultAddr}-${e.owner.toLowerCase()}`
                        let pos = await ctx.store.get(VaultV2Position, posId)
                        if (pos) {
                            pos.shares -= e.shares
                            pos.assets -= e.assets
                            await ctx.store.upsert(pos)
                        }

                        const nowSec = BigInt(Math.floor(block.header.timestamp / 1000))
                        await updateVaultState(ctx, vault, nowSec, vault.totalSupply - e.shares, vault.totalAssets - e.assets);

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
                } catch (err) {
                    ctx.log.error({ err, tx: log.transaction?.hash, addr }, `Error processing VaultV2 event`)
                }
            }
        }
    }
})