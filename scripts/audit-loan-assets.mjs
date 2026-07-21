#!/usr/bin/env node
/**
 * Audit: does every loan asset have a USD price source?
 *
 * The indexer derives a collateral token's USD price from its market's oracle
 * times the loan asset's USD price. That only produces dollars if the loan
 * asset itself is USD-denominated — it does not have to be a stablecoin, but
 * it does have to have a feed. A loan asset with neither resolves to the $1
 * placeholder, and every collateral priced through it is silently valued in
 * the loan asset rather than in USD.
 *
 * This lists the gaps up front, instead of waiting for the runtime warning to
 * appear once a market is indexed.
 *
 * Usage (per network, from the project root):
 *
 *   set -a && . ./.env.flare && set +a && node scripts/audit-loan-assets.mjs
 *
 * Exits non-zero when any loan asset is unpriceable, so it can gate a deploy.
 */
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const NETWORK = (process.env.NETWORK ?? 'UNKNOWN').toUpperCase()

const configPath = process.env.ORACLE_FEEDS_PATH
    ?? path.resolve(process.cwd(), 'oracle-feeds.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

const lower = s => String(s).toLowerCase()
const stablecoins = new Set((config.stablecoins?.[NETWORK] ?? []).map(lower))
const feeds = new Set(Object.keys(config.feeds?.[NETWORK] ?? {}).map(lower))

const client = new pg.Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASS,
})

await client.connect()

// Loan assets, with how much sits in markets that use them — so the biggest
// gaps sort to the top.
const { rows } = await client.query(`
    SELECT t.id, t.symbol, t.decimals,
           count(*)                       AS market_count,
           sum(m.total_supply_assets)     AS total_supply,
           bool_or(t.last_price_usd IS NOT NULL) AS has_price
    FROM market m
    JOIN token t ON t.id = m.borrowed_token_id
    GROUP BY t.id, t.symbol, t.decimals
    ORDER BY sum(m.total_supply_assets) DESC
`)
await client.end()

const classify = r =>
    stablecoins.has(lower(r.id)) ? 'stablecoin'
        : feeds.has(lower(r.id)) ? 'feed'
            : null

const gaps = rows.filter(r => classify(r) === null)

console.log(`\nLoan assets on ${NETWORK} (${rows.length} distinct)\n`)
for (const r of rows) {
    const source = classify(r)
    const supply = Number(r.total_supply) / 10 ** r.decimals
    console.log(
        `  ${source ? '✅' : '❌'} ${(r.symbol ?? '?').padEnd(10)} ${r.id}` +
        `  ${String(r.market_count).padStart(3)} market(s)` +
        `  supply ${supply.toLocaleString(undefined, { maximumFractionDigits: 2 }).padStart(16)}` +
        `  ${source ?? 'NO USD SOURCE'}`,
    )
}

if (gaps.length === 0) {
    console.log('\nAll loan assets have a USD price source.\n')
    process.exit(0)
}

console.log(
    `\n${gaps.length} loan asset(s) have no USD price source. Collateral in their ` +
    `markets cannot be priced in dollars, and their own USD figures fall back to $1.\n` +
    `Add each to oracle-feeds.json under stablecoins["${NETWORK}"] or feeds["${NETWORK}"]:\n`,
)
for (const r of gaps) console.log(`  "${r.id}": "0xFEED_ADDRESS_HERE",   // ${r.symbol}`)
console.log()
process.exit(1)
