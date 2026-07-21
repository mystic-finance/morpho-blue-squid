module.exports = class Data1784559482674 {
    name = 'Data1784559482674'

    async up(db) {
        await db.query(`ALTER TABLE "canton_market" RENAME COLUMN "current_contract_id" TO "market_cid"`)
        await db.query(`ALTER TABLE "canton_market" ADD "oracle_key" text`)
        await db.query(`ALTER TABLE "canton_market" ADD "params_oracle" text`)
        await db.query(`CREATE INDEX "IDX_c587b6d64fbf97febe43bd8eb9" ON "canton_market" ("oracle_key") `)
        await db.query(`CREATE INDEX "IDX_a2426f89a3fbfcbbe25e143c75" ON "canton_market" ("params_oracle") `)
    }

    async down(db) {
        await db.query(`ALTER TABLE "canton_market" RENAME COLUMN "market_cid" TO "current_contract_id"`)
        await db.query(`ALTER TABLE "canton_market" DROP COLUMN "oracle_key"`)
        await db.query(`ALTER TABLE "canton_market" DROP COLUMN "params_oracle"`)
        await db.query(`DROP INDEX "public"."IDX_c587b6d64fbf97febe43bd8eb9"`)
        await db.query(`DROP INDEX "public"."IDX_a2426f89a3fbfcbbe25e143c75"`)
    }
}
