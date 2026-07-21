/**
 * Gateway configuration.
 *
 * The gateway is a read-only presentation layer over the per-chain squid
 * databases. It owns no state and runs no migrations — every chain it serves
 * is described here: how to connect, and the off-chain metadata (icons,
 * categories, curator profiles) that the indexer has no way to observe.
 *
 * Config lives in gateway-config.json at the project root (override with
 * GATEWAY_CONFIG_PATH). Any string value may reference an env var with
 * ${VAR} so credentials stay out of the repo.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface ChainDbConfig {
    host: string
    port: number
    database: string
    user: string
    password: string
    ssl?: boolean
}

export type ChainKind = 'evm' | 'canton'

export interface ChainConfig {
    /** Numeric chain id exposed as `Chain.id` / accepted in `chainId_in`. */
    id: number
    /** Internal key, matches the squid's NETWORK env value. */
    key: string
    name: string
    icon?: string | null
    kind: ChainKind
    db: ChainDbConfig
    /**
     * JSON-RPC endpoint, read only for live `balanceOf` lookups (wallet
     * holdings). Optional: a chain without it simply reports null holdings.
     */
    rpc?: string | null
}

export interface TokenMetadata {
    icon?: string | null
    category?: string | null
    /** Overrides the on-chain name when set. */
    name?: string | null
}

export interface CuratorMetadata {
    name: string
    image?: string | null
    url?: string | null
}

export interface IrmConfig {
    /** 'adaptive-curve' enables curve sampling; anything else reports a flat curve. */
    type: string
    targetUtilization: number
    curveSteepness: number
    /**
     * AdaptiveCurveIrm rate bounds, as linear annualised fractions. Omit to
     * use the canonical ConstantsLib values (see src/gateway/irm.ts) — only
     * set these for a fork that deploys different constants.
     */
    initialRateAtTarget?: number
    minRateAtTarget?: number
    maxRateAtTarget?: number
}

export interface GatewayConfig {
    chains: ChainConfig[]
    /** chainId -> lowercased token address -> metadata */
    tokens: Record<string, Record<string, TokenMetadata>>
    /** lowercased curator address -> profile */
    curators: Record<string, CuratorMetadata>
    /** chainId -> lowercased IRM address -> params */
    irm: Record<string, Record<string, IrmConfig>>
    /** Fallback when an IRM address has no explicit entry. */
    defaultIrm: IrmConfig
}

const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH
    ?? path.resolve(process.cwd(), 'gateway-config.json')

/** Recursively expand ${ENV_VAR} references in every string leaf. */
function expandEnv<T>(value: T): T {
    if (typeof value === 'string') {
        return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? '') as unknown as T
    }
    if (Array.isArray(value)) return value.map(expandEnv) as unknown as T
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v)
        return out as T
    }
    return value
}

const DEFAULT_IRM: IrmConfig = {
    type: 'adaptive-curve',
    targetUtilization: 0.9,
    curveSteepness: 4,
}

let cached: GatewayConfig | null = null

export function loadConfig(): GatewayConfig {
    if (cached) return cached

    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = expandEnv(JSON.parse(raw)) as Partial<GatewayConfig>

    let chains = (parsed.chains ?? []).map(c => ({
        ...c,
        kind: c.kind ?? 'evm',
        db: { ...c.db, port: Number(c.db.port) },
    }))

    // GATEWAY_CHAINS pins an instance to a subset of the config file without
    // maintaining a second config: `GATEWAY_CHAINS=FLARE` makes this process
    // structurally incapable of reading any other chain's database, and a
    // request filtering on an excluded chainId simply returns nothing.
    const allowlist = (process.env.GATEWAY_CHAINS ?? '')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    if (allowlist.length > 0) {
        chains = chains.filter(c => allowlist.includes(c.key.toUpperCase()))
        console.log(`[gateway] GATEWAY_CHAINS set — serving only: ${chains.map(c => c.key).join(', ') || '(none)'}`)
    }

    if (chains.length === 0) {
        throw new Error(
            `[gateway] no chains configured in ${CONFIG_PATH}` +
            (allowlist.length > 0 ? ` matching GATEWAY_CHAINS=${allowlist.join(',')}` : ''),
        )
    }

    // Lowercase every address key once, so lookups never have to think about it.
    const lower = <T>(m: Record<string, T> | undefined): Record<string, T> =>
        Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k.toLowerCase(), v]))

    cached = {
        chains,
        tokens: Object.fromEntries(
            Object.entries(parsed.tokens ?? {}).map(([chainId, m]) => [chainId, lower(m)]),
        ),
        curators: lower(parsed.curators),
        irm: Object.fromEntries(
            Object.entries(parsed.irm ?? {}).map(([chainId, m]) => [chainId, lower(m)]),
        ),
        defaultIrm: parsed.defaultIrm ?? DEFAULT_IRM,
    }
    return cached
}

export function getChain(chainId: number): ChainConfig | undefined {
    return loadConfig().chains.find(c => c.id === chainId)
}

/** Chains to query when the caller supplied no `chainId_in` filter. */
export function resolveChains(chainIds?: number[] | null): ChainConfig[] {
    const all = loadConfig().chains
    if (!chainIds || chainIds.length === 0) return all
    return all.filter(c => chainIds.includes(c.id))
}

export function tokenMetadata(chainId: number, address: string): TokenMetadata {
    return loadConfig().tokens[String(chainId)]?.[address.toLowerCase()] ?? {}
}

export function curatorMetadata(address?: string | null): CuratorMetadata[] {
    if (!address) return []
    const found = loadConfig().curators[address.toLowerCase()]
    return found ? [found] : []
}

export function irmConfig(chainId: number, address?: string | null): IrmConfig {
    const cfg = loadConfig()
    if (!address) return cfg.defaultIrm
    return cfg.irm[String(chainId)]?.[address.toLowerCase()] ?? cfg.defaultIrm
}
