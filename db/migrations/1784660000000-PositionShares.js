/**
 * Add position.shares, and clear the corrupted balances it replaces.
 *
 * Morpho is share-denominated: a position's asset value accrues interest. The
 * indexer tracked `balance` as a running sum of event assets (+= on supply,
 * -= on withdraw), so a full exit subtracted more than was ever put in — the
 * difference being earned interest — and the balance went negative. The
 * gateway sums those balances for vault liquidity, which is why vaults were
 * reporting negative totalLiquidity (e.g. Re7 pUSD at -64,542 USD).
 *
 * `shares` is now the source of truth and `balance` is derived from it.
 *
 * Existing rows cannot be repaired in SQL: the true share balance was never
 * stored, and it is not recoverable from a corrupted asset sum. They are zeroed
 * here so nothing serves a negative number, and the processor's
 * backfillPositionShares() re-reads the authoritative supplyShares /
 * borrowShares / collateral from Morpho Blue's position(id, user) on startup.
 *
 * COLLATERAL positions are left alone: collateral does not accrue, so their
 * balances were already correct and shares stays 0 for them.
 */
module.exports = class PositionShares1784660000000 {
    name = 'PositionShares1784660000000'

    async up(db) {
        await db.query(`ALTER TABLE "position" ADD COLUMN IF NOT EXISTS "shares" numeric NOT NULL DEFAULT 0`)
        // Only the interest-accruing sides were corrupted.
        await db.query(`
            UPDATE "position"
            SET "balance" = 0, "balance_usd" = 0
            WHERE "side" IN ('LENDER', 'BORROWER')
        `)
    }

    async down(db) {
        await db.query(`ALTER TABLE "position" DROP COLUMN IF EXISTS "shares"`)
    }
}
