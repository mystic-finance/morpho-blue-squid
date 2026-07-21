/**
 * Add meta_morpho.guardian (v1 only) and vault_v2.performance_fee.
 *
 * Both are role/fee values the processor previously never stored:
 *
 *   - `guardian` was not indexed at all; the gateway hard-coded null.
 *   - vault_v2 had no fee column; the gateway hard-coded 0.
 *
 * Related and NOT fixed by this migration: meta_morpho.fee was written once at
 * vault creation and never updated, because SetFee had no handler. Existing
 * rows therefore hold a stale fee — e.g. Mystic wETH on Plume stores 0 while
 * the contract returns 1.5e17 (15%). That matters beyond the reported
 * performanceFee: the gateway derives net supply APY as apy(row.apy, fee/WAD),
 * so a stale zero fee overstates the APY shown to users.
 *
 * Neither new column can be backfilled in SQL — guardian() and
 * performanceFee() are contract reads, and the stale fee needs the current
 * on-chain value. Backfill therefore requires either an RPC sweep over
 * existing vault rows or a re-index; see scripts/. Until then new columns read
 * null/0 for vaults indexed before this migration, which is the same as the
 * hard-coded values they replace — so this migration is safe to apply ahead of
 * the backfill.
 */
module.exports = class VaultGuardianAndPerformanceFee1784648000000 {
    name = 'VaultGuardianAndPerformanceFee1784648000000'

    async up(db) {
        await db.query(`ALTER TABLE "meta_morpho" ADD COLUMN IF NOT EXISTS "guardian" text`)
        // NOT NULL with a 0 default: the entity types it as a non-nullable
        // bigint, and 0 is what the gateway reported for every V2 vault before.
        await db.query(`
            ALTER TABLE "vault_v2"
            ADD COLUMN IF NOT EXISTS "performance_fee" numeric NOT NULL DEFAULT 0
        `)
    }

    async down(db) {
        await db.query(`ALTER TABLE "meta_morpho" DROP COLUMN IF EXISTS "guardian"`)
        await db.query(`ALTER TABLE "vault_v2" DROP COLUMN IF EXISTS "performance_fee"`)
    }
}
