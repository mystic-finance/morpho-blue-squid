#!/usr/bin/env node
/**
 * Inspect or move the squid's recorded indexing height.
 *
 * WHY THIS EXISTS
 *
 * `START_BLOCK` is not a way to move the indexer. It bounds the *stream* — the
 * portal source intersects it with the runner's request for `recordedHeight+1`
 * — but the `status` row in Postgres is only ever rewritten when a batch
 * successfully commits. So if batches are failing (rate-limited RPC, a throw in
 * the handler, a container restart mid-batch), raising START_BLOCK makes the
 * processor read current blocks while the recorded height sits unchanged at
 * wherever it last committed, possibly years back. Every restart re-reports
 * that stale height, which reads like the indexer "went backwards" when in
 * fact it never went forwards.
 *
 * This script edits that row directly, so a fast-forward is explicit and
 * visible instead of implied.
 *
 * IMPORTANT: fast-forwarding leaves a HOLE. Blocks between the old height and
 * the new one are never indexed, and nothing in the schema records that. Only
 * do this when you have decided that history is expendable (or are backfilling
 * it another way), and write down what you skipped.
 *
 * Usage, from the project root:
 *
 *   # show current state, change nothing
 *   set -a && . ./.env.base && set +a && node scripts/reset-indexer-height.mjs
 *
 *   # fast-forward to a block (skips everything in between)
 *   set -a && . ./.env.base && set +a && \
 *     node scripts/reset-indexer-height.mjs --to 49176839
 *
 *   # start over from START_BLOCK, keeping indexed entities
 *   set -a && . ./.env.base && set +a && \
 *     node scripts/reset-indexer-height.mjs --reset
 *
 * Stop the processor first. Editing the row underneath a running processor
 * trips typeorm-store's optimistic nonce check and kills it mid-batch.
 */
import pg from 'pg'

const args = process.argv.slice(2)
const has = flag => args.includes(flag)
const valueOf = flag => {
    const i = args.indexOf(flag)
    return i === -1 ? undefined : args[i + 1]
}

const NETWORK = process.env.NETWORK ?? 'UNKNOWN'
const doReset = has('--reset')
const toArg = valueOf('--to')

if (doReset && toArg !== undefined) {
    console.error('Pass either --to <block> or --reset, not both.')
    process.exit(1)
}

const client = new pg.Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASS,
})

await client.connect()

const { rows } = await client.query(`SELECT height, hash, nonce FROM status WHERE id = 0`)
if (rows.length === 0) {
    console.error('No status row — this database has never been indexed. Nothing to do.')
    await client.end()
    process.exit(1)
}

const current = rows[0]
const startBlock = Number(process.env.START_BLOCK ?? 0)

console.log(`network:          ${NETWORK}`)
console.log(`database:         ${process.env.DB_NAME}`)
console.log(`recorded height:  ${current.height}`)
console.log(`recorded hash:    ${current.hash}`)
console.log(`START_BLOCK:      ${startBlock}`)

if (Number(current.height) < startBlock) {
    console.log(
        `\nNOTE: recorded height is BELOW START_BLOCK. The processor is reading from ` +
        `${startBlock} while still reporting ${current.height}, and will keep reporting ` +
        `${current.height} until a batch actually commits. If that has not happened, the ` +
        `problem is the batch failing, not the block range.`,
    )
}

if (!doReset && toArg === undefined) {
    console.log('\nRead-only. Pass --to <block> or --reset to change it.')
    await client.end()
    process.exit(0)
}

// -1 / '0x' is the sentinel typeorm-store writes for a virgin database, so the
// runner treats the next stream request as "start at the configured from".
const target = doReset ? -1 : Number(toArg)

if (!Number.isSafeInteger(target)) {
    console.error(`--to must be an integer block number, got: ${toArg}`)
    await client.end()
    process.exit(1)
}
if (!doReset && target < Number(current.height)) {
    console.error(
        `Refusing to move the height BACKWARDS (${current.height} -> ${target}). ` +
        `The runner asserts blocks arrive strictly increasing, and rewinding without ` +
        `deleting the entities written above ${target} leaves double-counted rows. ` +
        `Use --reset plus a full data wipe if you really want to re-index.`,
    )
    await client.end()
    process.exit(1)
}

// The hash must be cleared alongside the height: typeorm-store asserts the
// stored hash matches the head it is committing on top of, and the old hash
// belongs to a block that is no longer the parent of anything.
await client.query(`UPDATE status SET height = $1, hash = '0x', nonce = nonce + 1 WHERE id = 0`, [target])
// Hot blocks describe unfinalized tip state that is now meaningless.
await client.query(`DELETE FROM hot_block`)

const skipped = doReset ? 0 : target - Number(current.height)
console.log(`\nheight: ${current.height} -> ${target}${doReset ? ' (virgin — will resume from START_BLOCK)' : ''}`)
if (skipped > 0) {
    console.log(`SKIPPED ${skipped.toLocaleString()} blocks. These are permanently unindexed.`)
}
console.log('Start the processor again.')

await client.end()
