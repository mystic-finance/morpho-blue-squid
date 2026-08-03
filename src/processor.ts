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
import { EvmBatchProcessor } from '@subsquid/evm-processor'
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

/**
 * Optional allowlist of vault addresses, comma-separated.
 *
 * MetaMorpho/VaultV2 logs are normally matched by topic alone, with no address
 * filter, so any vault is picked up without being registered anywhere. That is
 * fine on a small chain, but two of those topics — ERC4626
 * `Deposit`/`Withdraw` — are shared by every ERC4626 vault in existence. On
 * Ethereum or Base that matches an enormous volume of logs that have nothing to
 * do with Morpho, each costing an `identifyVault` RPC probe the first time its
 * address is seen (the verdict is then cached, so it is paid once per address).
 *
 * Setting this pins the vault log queries to known addresses and drops that
 * cost to zero. Unset = current behaviour, unchanged, on every chain.
 */
export const VAULT_ADDRESSES = IS_CANTON
    ? []
    : (process.env.VAULT_ADDRESSES ?? '')
          .split(',')
          .map(a => a.trim().toLowerCase())
          .filter(a => a !== '')

if (!IS_CANTON) {
    console.log(VAULT_ADDRESSES.length > 0
        ? `[processor] Vault log filter: ${VAULT_ADDRESSES.length} address(es) from VAULT_ADDRESSES`
        : '[processor] VAULT_ADDRESSES unset — matching MetaMorpho/VaultV2 logs by topic on every address')
}

if (!IS_CANTON && !process.env.RPC_ENDPOINT) {
    throw new Error('RPC_ENDPOINT is required for an EVM network. Set it in the env file.')
}

/**
 * Portal dataset per network. Override with PORTAL_URL for a private portal or
 * a dataset rename.
 *
 * A network with no dataset (Citrea — confirmed absent from the portal's 228
 * datasets) cannot use this data source at all: DataSourceBuilder is
 * portal-only and, unlike EvmBatchProcessor, has no RPC ingestion path. Those
 * networks keep the legacy EvmBatchProcessor below, driven purely by RPC.
 * That path never touched the deprecated gateway, so it is unaffected by the
 * portal migration.
 */
const PORTAL_DATASETS: Record<string, string> = {
    FLARE: 'https://portal.sqd.dev/datasets/flare-mainnet',
    PLUME: 'https://portal.sqd.dev/datasets/plume-mainnet',
    BERACHAIN: 'https://portal.sqd.dev/datasets/berachain-mainnet',
    ETHEREUM: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
    BASE: 'https://portal.sqd.dev/datasets/base-mainnet',
}

export const PORTAL_URL = IS_CANTON
    ? ''
    : (process.env.PORTAL_URL ?? PORTAL_DATASETS[process.env.NETWORK ?? ''] ?? '')

/** True when this network ingests from the portal; false = legacy RPC path. */
export const USE_PORTAL = !IS_CANTON && PORTAL_URL !== ''

if (!IS_CANTON) {
    console.log(USE_PORTAL
        ? `[processor] Portal ingestion: ${PORTAL_URL}`
        : `[processor] No portal dataset for ${process.env.NETWORK} — RPC-only ingestion via EvmBatchProcessor`)
}

const LOG_FILTERS = {
    morphoBlue: [
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
    metaMorpho: [
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
    vaultV2: [
        vaultV2Abi.events.Deposit.topic,
        vaultV2Abi.events.Withdraw.topic,
        vaultV2Abi.events.SetCurator.topic,
        vaultV2Abi.events.IncreaseAbsoluteCap.topic,
        vaultV2Abi.events.DecreaseAbsoluteCap.topic,
        vaultV2Abi.events.IncreaseRelativeCap.topic,
        vaultV2Abi.events.Allocate.topic,
        vaultV2Abi.events.Deallocate.topic,
    ],
    publicAllocator: [
        publicAllocatorAbi.events.SetFlowCaps.topic,
        publicAllocatorAbi.events.PublicWithdrawal.topic,
        publicAllocatorAbi.events.PublicReallocateTo.topic,
    ],
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
        .setPortal(PORTAL_URL)
        .setBlockRange({ from: Number(process.env.START_BLOCK ?? 0) })
        .setFields(FIELDS)

    builder.addLog({
        where: { address: [MORPHO_BLUE], topic0: LOG_FILTERS.morphoBlue },
        include: { transaction: true },
    })

    // MetaMorpho / VaultV2 events are unfiltered by address — they catch all
    // vaults — unless VAULT_ADDRESSES pins them to a known set.
    const vaultAddress = VAULT_ADDRESSES.length > 0 ? { address: VAULT_ADDRESSES } : {}

    builder.addLog({
        where: { ...vaultAddress, topic0: LOG_FILTERS.metaMorpho },
        include: { transaction: true },
    })

    builder.addLog({
        where: { ...vaultAddress, topic0: LOG_FILTERS.vaultV2 },
        include: { transaction: true },
    })

    // PublicAllocator flow caps — address-filtered, so this adds no scan cost
    // on chains where it isn't deployed.
    if (PUBLIC_ALLOCATOR) {
        builder.addLog({
            where: { address: [PUBLIC_ALLOCATOR], topic0: LOG_FILTERS.publicAllocator },
            include: { transaction: true },
        })
    }

    return builder.build()
}

/**
 * Legacy RPC-only ingestion, for networks the portal has no dataset for.
 *
 * This is the pre-migration EvmBatchProcessor path with no `.setGateway()`
 * call, so it never touches the deprecated gateway API — it reads blocks
 * straight from the RPC endpoint. Slower than the portal, but it is the only
 * option for a chain SQD does not index, and it is exactly how Citrea already
 * ran before the migration.
 */
function buildRpcProcessor() {
    const p = new EvmBatchProcessor()
        .setRpcEndpoint({
            url: process.env.RPC_ENDPOINT!,
            rateLimit: Number(process.env.RPC_RATE_LIMIT ?? 100),
            capacity: Number(process.env.RPC_CAPACITY ?? 100),
            maxBatchCallSize: 100,
            requestTimeout: 60000,
        })
        .setFinalityConfirmation(10)
        .setBlockRange({ from: Number(process.env.START_BLOCK ?? 0) })

    const vaultAddress = VAULT_ADDRESSES.length > 0 ? { address: VAULT_ADDRESSES } : {}

    p.addLog({ address: [MORPHO_BLUE], topic0: LOG_FILTERS.morphoBlue, transaction: true })
    p.addLog({ ...vaultAddress, topic0: LOG_FILTERS.metaMorpho, transaction: true })
    p.addLog({ ...vaultAddress, topic0: LOG_FILTERS.vaultV2, transaction: true })
    if (PUBLIC_ALLOCATOR) {
        p.addLog({ address: [PUBLIC_ALLOCATOR], topic0: LOG_FILTERS.publicAllocator, transaction: true })
    }

    return p
}

// Exactly one of these is built per boot; Canton builds neither.
export const dataSource = USE_PORTAL ? buildDataSource() : (null as any)
export const processor = !IS_CANTON && !USE_PORTAL ? buildRpcProcessor() : (null as any)
