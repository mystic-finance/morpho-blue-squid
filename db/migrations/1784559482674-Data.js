module.exports = class Data1784559482674 {
    name = 'Data1784559482674'

    // Adds the CantonMarket oracle-join columns (oracleKey / paramsOracle) on
    // top of main's chain. The `current_contract_id -> market_cid` rename that
    // this migration used to also perform is already done, guarded, by
    // FixCantonMarketCid1781533995851 — repeating it here (unguarded) would
    // abort the batch once the column has been renamed, so it is intentionally
    // omitted. Adds are idempotent to match the defensive style of the rest of
    // the chain and to survive a drifted `migrations` ledger replay.
    async up(db) {
        await db.query(`ALTER TABLE "canton_market" ADD COLUMN IF NOT EXISTS "oracle_key" text`)
        await db.query(`ALTER TABLE "canton_market" ADD COLUMN IF NOT EXISTS "params_oracle" text`)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_c587b6d64fbf97febe43bd8eb9" ON "canton_market" ("oracle_key") `)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_a2426f89a3fbfcbbe25e143c75" ON "canton_market" ("params_oracle") `)
    }

    async down(db) {
        await db.query(`DROP INDEX "public"."IDX_a2426f89a3fbfcbbe25e143c75"`)
        await db.query(`DROP INDEX "public"."IDX_c587b6d64fbf97febe43bd8eb9"`)
        await db.query(`ALTER TABLE "canton_market" DROP COLUMN "params_oracle"`)
        await db.query(`ALTER TABLE "canton_market" DROP COLUMN "oracle_key"`)
    }
}
