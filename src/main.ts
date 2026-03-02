import { TypeormDatabase } from '@subsquid/typeorm-store'
import { processor, MORPHO_BLUE } from './processor'
import * as morphoBlue from './abi/MorphoBlue'
import * as metaMorpho from './abi/MetaMorpho'
import * as erc20Abi from './abi/ERC20'
import {
    LendingProtocol, Market, Token, Account, Position, InterestRate,
    Deposit, Withdraw, Borrow, Repay, Liquidate,
    MetaMorpho, MetaMorphoPosition, MetaMorphoDeposit, MetaMorphoWithdraw,
    MetaMorphoMarketAllocation, MetaMorphoMarketWithdrawAllocation,
    PositionSide, InterestRateSide, InterestRateType,
} from './model'
import { DataHandlerContext } from '@subsquid/evm-processor'
import { Store } from '@subsquid/typeorm-store'
import { In } from 'typeorm'
import * as vaultV2Abi from './abi/VaultV2'
import { VaultV2, VaultV2Position, VaultV2Deposit, VaultV2Withdraw, VaultV2Allocation } from './model'


const PROTOCOL_ID = 'morpho-blue'
const NETWORK = process.env.NETWORK ?? 'UNKNOWN'
// Comma-separated list of known VaultV2 addresses from .env
const VAULT_V2_ADDRESSES = new Set(
    (process.env.VAULT_V2_ADDRESSES ?? '').split(',').map(a => a.toLowerCase()).filter(Boolean)
)

const VAULT_V1_ADDRESSES = new Set(
    (process.env.VAULT_V1_ADDRESSES ?? '').split(',').map(a => a.toLowerCase()).filter(Boolean)
)

// ---- Helpers ----

function positionId(account: string, market: string, side: PositionSide) {
    return `${account}-${market}-${side}`
}

function eventId(txHash: string, logIndex: number) {
    return `${txHash}-${logIndex}`
}

async function getOrCreateToken(ctx: DataHandlerContext<Store>, address: string): Promise<Token> {
    let token = await ctx.store.get(Token, address)
    if (!token) {
        // Minimal token — you can enrich this with ERC20 RPC calls if needed
        token = new Token({
            id: address,
            name: address.slice(0, 8),
            symbol: '???',
            decimals: 18,
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
                }

                // AccrueInterest — update borrow rate
                // if (topic === morphoBlue.events.AccrueInterest.topic) {
                //     const e = morphoBlue.events.AccrueInterest.decode(log)
                //     const market = await ctx.store.get(Market, e.id)
                //     if (!market) continue
                //     market.totalBorrowAssets += e.interest
                //     market.totalSupplyAssets += e.interest
                //     market.lastUpdate = BigInt(block.header.timestamp)

                //     // Update interest rate (annualised borrow rate from event)
                //     const rateId = `${e.id}-${InterestRateSide.BORROWER}`
                //     const rate = await ctx.store.get(InterestRate, rateId)
                //     if (rate) {
                //         rate.rate = e.borrowRateView as any  // raw WAD
                //         await ctx.store.upsert(rate)
                //     }
                //     await ctx.store.upsert(market)
                // }
                // ✅ CORRECT — use prevBorrowRate from the event
                if (topic === morphoBlue.events.AccrueInterest.topic) {
                    const e = morphoBlue.events.AccrueInterest.decode(log)
                    const market = await ctx.store.get(Market, e.id)
                    if (!market) continue

                    market.totalBorrowAssets += e.interest
                    market.totalSupplyAssets += e.interest
                    market.lastUpdate = BigInt(block.header.timestamp)

                    // prevBorrowRate is the per-second borrow rate (WAD-scaled)
                    // This is what the official subgraph stores as the rate
                    const borrowRateId = `${e.id}-${InterestRateSide.BORROWER}`
                    const borrowRate = await ctx.store.get(InterestRate, borrowRateId)
                    if (borrowRate) {
                        borrowRate.rate = e.prevBorrowRate as any
                        await ctx.store.upsert(borrowRate)
                    }

                    // Derive lender rate: supplyRate = borrowRate * utilization * (1 - fee)
                    // Store a placeholder for now; you can compute it properly from market state
                    const lenderRateId = `${e.id}-${InterestRateSide.LENDER}`
                    const lenderRate = await ctx.store.get(InterestRate, lenderRateId)
                    if (lenderRate && market.totalSupplyAssets > 0n) {
                        const utilization = (market.totalBorrowAssets * BigInt(1e18)) / market.totalSupplyAssets
                        // lendRate ≈ borrowRate * utilization / WAD * (1 - fee/WAD)
                        const feeFactor = BigInt(1e18) - market.fee
                        const lendRateRaw = (e.prevBorrowRate * utilization * feeFactor) / BigInt(1e18) / BigInt(1e18)
                        lenderRate.rate = lendRateRaw as any
                        await ctx.store.upsert(lenderRate)
                    }

                    await ctx.store.upsert(market)
                }
            }

            // ══════════════════════════════════════════
            // METAMORPHO VAULT EVENTS
            // ══════════════════════════════════════════

            try {
                if (topic === metaMorpho.events.Deposit.topic) {
                    const e = metaMorpho.events.Deposit.decode(log)
                    let vault = await ctx.store.get(MetaMorpho, log.address.toLowerCase())
                    if (!vault) continue  // not a known vault yet
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
                    const posId = `${log.address.toLowerCase()}-${e.owner.toLowerCase()}`
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
                    vault.totalSupply += e.shares
                    vault.totalAssets += e.assets
                    await ctx.store.upsert(pos)
                    await ctx.store.upsert(vault)
                }

                if (topic === metaMorpho.events.Withdraw.topic) {
                    const e = metaMorpho.events.Withdraw.decode(log)
                    let vault = await ctx.store.get(MetaMorpho, log.address.toLowerCase())
                    if (!vault) continue
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

                    vault.totalSupply -= e.shares
                    vault.totalAssets -= e.assets
                    await ctx.store.upsert(vault)
                }

                // SetCap — track market allocations in vault's supplyQueue
                if (topic === metaMorpho.events.SetCap.topic) {
                    const e = metaMorpho.events.SetCap.decode(log)
                    const vault = await ctx.store.get(MetaMorpho, log.address.toLowerCase())
                    if (!vault) continue
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

            } catch {
                // log was not a MetaMorpho event we care about
            }

            // ══════════════════════════════════════════
            // VAULT V2 EVENTS
            // ══════════════════════════════════════════

            if (VAULT_V2_ADDRESSES.has(log.address.toLowerCase())) {
                const vaultAddr = log.address.toLowerCase()

                // ERC4626 Deposit
                if (topic === vaultV2Abi.events.Deposit.topic) {
                    const e = vaultV2Abi.events.Deposit.decode(log)
                    let vault = await ctx.store.get(VaultV2, vaultAddr)
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
                    vault.totalSupply += e.shares
                    vault.totalAssets += e.assets
                    await ctx.store.upsert(pos)
                    await ctx.store.upsert(vault)
                }

                // ERC4626 Withdraw
                if (topic === vaultV2Abi.events.Withdraw.topic) {
                    const e = vaultV2Abi.events.Withdraw.decode(log)
                    let vault = await ctx.store.get(VaultV2, vaultAddr)
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

                    vault.totalSupply -= e.shares
                    vault.totalAssets -= e.assets
                    await ctx.store.upsert(vault)
                }

                // IncreaseAbsoluteCap — track allocation caps per (vault, id)
                if (topic === vaultV2Abi.events.IncreaseAbsoluteCap.topic) {
                    const e = vaultV2Abi.events.IncreaseAbsoluteCap.decode(log)
                    const vault = await ctx.store.get(VaultV2, vaultAddr)
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
                    const vault = await ctx.store.get(VaultV2, vaultAddr)
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
                    const vault = await ctx.store.get(VaultV2, vaultAddr)
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
            }
        }
    }
})