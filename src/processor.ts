/**
 * Portal data source.
 *
 * Migrated from EvmBatchProcessor + .setGateway() to DataSourceBuilder +
 * .setPortal(), per https://docs.sqd.dev/en/sdk/migration/gateway-to-portal.
 *
 * Gateways were deprecated on 2026-05-19 and now demand a gateway API key.
 * The old code pointed the legacy gateway client at a Portal URL, which Portal
 * used to tolerate and no longer does — it fails at startup with
 *   HTTP 400 — Bad request: missing field `type`
 * from Runner.assertWeAreOnTheSameChain. Portal itself needs no API key.
 *
 * `.setPortal()` does not exist on EvmBatchProcessor, so the data source had to
 * move to @subsquid/evm-stream and the run loop to @subsquid/batch-processor.
 */
import { DataSourceBuilder } from '@subsquid/evm-stream'
import * as morphoBlue from './abi/MorphoBlue'
import * as metaMorpho from './abi/MetaMorpho'
import * as vaultV2Abi from './abi/VaultV2'
import * as publicAllocatorAbi from './abi/PublicAllocator'

console.log(`[processor] Initializing for network: ${process.env.NETWORK ?? 'UNKNOWN'}`);

// When NETWORK=CANTON, this file is still imported by src/main.ts but the
// data source below is never run. Skip the RPC/Morpho-address reads that would
// crash on missing Canton env (CANTON has no RPC, no MORPHO_BLUE).
const IS_CANTON = process.env.NETWORK === 'CANTON'

if (!IS_CANTON) {
    console.log(`[processor] RPC Endpoint: ${process.env.RPC_ENDPOINT?.split('@').pop()}`);
}

function requireEnv(name: string): string {
    const v = process.env[name]
    if (!v) throw new Error(`${name} is required for an EVM network (NETWORK=${process.env.NETWORK ?? 'UNKNOWN'}). Set it in the env file.`)
    return v
}

export const MORPHO_BLUE = IS_CANTON ? '' : requireEnv('MORPHO_BLUE_ADDRESS').toLowerCase()

// PublicAllocator is optional — not every chain has one deployed. When
// unset, flow-cap indexing is simply skipped and the gateway reports a
// publicAllocatorSharedLiquidity of 0.
// Canonical addresses: https://docs.morpho.org/developers/contracts/addresses/
export const PUBLIC_ALLOCATOR = IS_CANTON
    ? ''
    : (process.env.PUBLIC_ALLOCATOR_ADDRESS ?? '').toLowerCase()

if (!IS_CANTON && !PUBLIC_ALLOCATOR) {
    console.log('[processor] PUBLIC_ALLOCATOR_ADDRESS unset — skipping flow-cap indexing')
}

if (!IS_CANTON && !process.env.RPC_ENDPOINT) {
    throw new Error('RPC_ENDPOINT is required for an EVM network. Set it in the env file.')
}

/**
 * Portal dataset per network. Override with PORTAL_URL for a private portal or
 * a dataset rename. Citrea has no dataset, so it falls back to RPC-only
 * ingestion — the same as before this migration.
 */
const PORTAL_DATASETS: Record<string, string> = {
    FLARE: 'https://portal.sqd.dev/datasets/flare-mainnet',
    PLUME: 'https://portal.sqd.dev/datasets/plume-mainnet',
}

export const PORTAL_URL = IS_CANTON
    ? ''
    : (process.env.PORTAL_URL ?? PORTAL_DATASETS[process.env.NETWORK ?? ''] ?? '')

if (!IS_CANTON) {
    console.log(PORTAL_URL
        ? `[processor] Portal: ${PORTAL_URL}`
        : `[processor] No portal dataset for ${process.env.NETWORK} — RPC-only ingestion`)
}

/**
 * Fields the mapping actually reads. Unlike the gateway API, Portal returns
 * *nothing* beyond the required keys unless it is named here — an omitted
 * field arrives as undefined rather than erroring, so this list has to stay in
 * sync with the handler.
 */
const FIELDS = {
    block: { timestamp: true },
    log: { address: true, topics: true, data: true, transactionHash: true },
    transaction: { hash: true },
} as const

function buildDataSource() {
    const builder = new DataSourceBuilder()
        .setBlockRange({ from: Number(process.env.START_BLOCK ?? 0) })
        .setFields(FIELDS)

    if (PORTAL_URL) builder.setPortal(PORTAL_URL)

    // All MorphoBlue events
    builder.addLog({
        where: {
            address: [MORPHO_BLUE],
            topic0: [
                morphoBlue.events.CreateMarket.topic,
                morphoBlue.events.Supply.topic,
                morphoBlue.events.Withdraw.topic,
                morphoBlue.events.Borrow.topic,
                morphoBlue.events.Repay.topic,
                morphoBlue.events.SupplyCollateral.topic,
                morphoBlue.events.WithdrawCollateral.topic,
                morphoBlue.events.Liquidate.topic,
                morphoBlue.events.AccrueInterest.topic,
                morphoBlue.events.SetFee.topic,
            ],
        },
        include: { transaction: true },
    })

    // MetaMorpho vault events (unfiltered by address — catches all vaults)
    builder.addLog({
        where: {
            topic0: [
                metaMorpho.events.Deposit.topic,
                metaMorpho.events.Withdraw.topic,
                metaMorpho.events.SetCap.topic,
                metaMorpho.events.SubmitCap.topic,
                metaMorpho.events.SetFee.topic,
                metaMorpho.events.SetFeeRecipient.topic,
                metaMorpho.events.SetTimelock.topic,
                metaMorpho.events.SetCurator.topic,
                metaMorpho.events.ReallocateSupply.topic,
                metaMorpho.events.ReallocateWithdraw.topic,
                metaMorpho.events.UpdateLastTotalAssets.topic,
            ],
        },
        include: { transaction: true },
    })

    builder.addLog({
        where: {
            topic0: [
                vaultV2Abi.events.Deposit.topic,
                vaultV2Abi.events.Withdraw.topic,
                vaultV2Abi.events.SetCurator.topic,
                vaultV2Abi.events.IncreaseAbsoluteCap.topic,
                vaultV2Abi.events.DecreaseAbsoluteCap.topic,
                vaultV2Abi.events.IncreaseRelativeCap.topic,
                vaultV2Abi.events.Allocate.topic,
                vaultV2Abi.events.Deallocate.topic,
            ],
        },
        include: { transaction: true },
    })

    // PublicAllocator flow caps — address-filtered, so this adds no scan cost
    // on chains where it isn't deployed.
    if (PUBLIC_ALLOCATOR) {
        builder.addLog({
            where: {
                address: [PUBLIC_ALLOCATOR],
                topic0: [
                    publicAllocatorAbi.events.SetFlowCaps.topic,
                    publicAllocatorAbi.events.PublicWithdrawal.topic,
                    publicAllocatorAbi.events.PublicReallocateTo.topic,
                ],
            },
            include: { transaction: true },
        })
    }

    return builder.build()
}

// Canton never runs this; keep it a lazy no-op sentinel there so importing
// this module on a Canton boot stays side-effect free.
export const dataSource = IS_CANTON ? (null as any) : buildDataSource()
