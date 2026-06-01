// Canton-only schema migration.
//
// Originally generated from a comparison against an empty DB, which made
// the auto-generator emit CREATE TABLE for all 33 entities in
// schema.graphql (28 EVM-side + 5 Canton-side + token). For the Canton
// indexer DB (morpho_canton) we only need the Canton tables plus `token`
// (shared by both networks; canton_market has FKs into it).
//
// Manually pruned the 28 unused EVM-side CREATE TABLE / FK / DROP TABLE
// statements. If you regenerate from an empty DB you'll get them back —
// re-prune as needed, or strip via:
//
//   keep:  CREATE TABLE "token" ...
//          CREATE TABLE "canton_*" ...
//          CREATE INDEX ... ON "canton_*" ...
//          ALTER TABLE "canton_*" ADD CONSTRAINT ... REFERENCES ...
//          mirror DROPs in down()
module.exports = class Data1780324949514 {
    name = 'Data1780324949514'

    async up(db) {
        // Shared entity — Canton tokens use this same table as EVM tokens.
        await db.query(`CREATE TABLE "token" ("id" character varying NOT NULL, "name" text NOT NULL, "symbol" text NOT NULL, "decimals" integer NOT NULL, "last_price_usd" numeric, "last_price_block_number" numeric, CONSTRAINT "PK_82fae97f905930df5d62a702fc9" PRIMARY KEY ("id"))`)

        // CantonMarket — id = oracle cid (churn-stable).
        await db.query(`CREATE TABLE "canton_market" ("id" character varying NOT NULL, "current_contract_id" text NOT NULL, "irm" text NOT NULL, "lltv" numeric NOT NULL, "liquidation_threshold" numeric NOT NULL, "fee" numeric NOT NULL, "total_supply_assets" numeric NOT NULL, "total_supply_shares" numeric NOT NULL, "total_borrow_assets" numeric NOT NULL, "total_borrow_shares" numeric NOT NULL, "borrow_apy" numeric NOT NULL, "supply_apy" numeric NOT NULL, "last_update" numeric NOT NULL, "loan_token_id" character varying, "collateral_token_id" character varying, CONSTRAINT "PK_db3576558163a8442c6625a565d" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX "IDX_9593e652ba49b368c57eae9b2e" ON "canton_market" ("loan_token_id") `)
        await db.query(`CREATE INDEX "IDX_49b116226e02291b4c8dcce4e5" ON "canton_market" ("collateral_token_id") `)

        // Daily / hourly snapshots — chart's time-series source.
        await db.query(`CREATE TABLE "canton_market_daily_snapshot" ("id" character varying NOT NULL, "day_id" integer NOT NULL, "timestamp" numeric NOT NULL, "total_supply_assets" numeric NOT NULL, "total_supply_shares" numeric NOT NULL, "total_borrow_assets" numeric NOT NULL, "total_borrow_shares" numeric NOT NULL, "borrow_apy" numeric NOT NULL, "supply_apy" numeric NOT NULL, "market_id" character varying, CONSTRAINT "PK_f62eb2ee4971bd509be61e6e0aa" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX "IDX_22f1f9dc2d2e46136f42665272" ON "canton_market_daily_snapshot" ("market_id") `)
        await db.query(`CREATE TABLE "canton_market_hourly_snapshot" ("id" character varying NOT NULL, "hour_id" integer NOT NULL, "timestamp" numeric NOT NULL, "total_supply_assets" numeric NOT NULL, "total_supply_shares" numeric NOT NULL, "total_borrow_assets" numeric NOT NULL, "total_borrow_shares" numeric NOT NULL, "borrow_apy" numeric NOT NULL, "supply_apy" numeric NOT NULL, "market_id" character varying, CONSTRAINT "PK_9b2b1c96092579a499fbf8b069d" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX "IDX_3d7badec6b47a7855ad07fa206" ON "canton_market_hourly_snapshot" ("market_id") `)

        // Lineage — every Market cid ever observed → its oracle. Append-only.
        await db.query(`CREATE TABLE "canton_market_lineage" ("id" character varying NOT NULL, "first_seen" numeric NOT NULL, "last_seen" numeric NOT NULL, "archived_at" numeric, "market_id" character varying, CONSTRAINT "PK_1074f694b771d6e5fd10c69994f" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX "IDX_e7f64b367c0a9df5f005383eec" ON "canton_market_lineage" ("market_id") `)

        // Indexer offset / cursor. Singleton row, id='canton-indexer'.
        await db.query(`CREATE TABLE "canton_indexer_state" ("id" character varying NOT NULL, "last_offset" text NOT NULL, "last_event_time" numeric NOT NULL, "events_processed" numeric NOT NULL, "updated_at" numeric NOT NULL, CONSTRAINT "PK_840cbe0d5741addec4628a58be7" PRIMARY KEY ("id"))`)

        // Foreign keys — added after table creation so dependency order
        // doesn't matter for the CREATE TABLE statements above.
        await db.query(`ALTER TABLE "canton_market" ADD CONSTRAINT "FK_9593e652ba49b368c57eae9b2e6" FOREIGN KEY ("loan_token_id") REFERENCES "token"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
        await db.query(`ALTER TABLE "canton_market" ADD CONSTRAINT "FK_49b116226e02291b4c8dcce4e5f" FOREIGN KEY ("collateral_token_id") REFERENCES "token"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
        await db.query(`ALTER TABLE "canton_market_daily_snapshot" ADD CONSTRAINT "FK_22f1f9dc2d2e46136f426652727" FOREIGN KEY ("market_id") REFERENCES "canton_market"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
        await db.query(`ALTER TABLE "canton_market_hourly_snapshot" ADD CONSTRAINT "FK_3d7badec6b47a7855ad07fa2063" FOREIGN KEY ("market_id") REFERENCES "canton_market"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
        await db.query(`ALTER TABLE "canton_market_lineage" ADD CONSTRAINT "FK_e7f64b367c0a9df5f005383eec0" FOREIGN KEY ("market_id") REFERENCES "canton_market"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
    }

    async down(db) {
        // Drop FKs first, then tables in reverse dependency order. Indexes
        // drop automatically with their tables.
        await db.query(`ALTER TABLE "canton_market_lineage" DROP CONSTRAINT "FK_e7f64b367c0a9df5f005383eec0"`)
        await db.query(`ALTER TABLE "canton_market_hourly_snapshot" DROP CONSTRAINT "FK_3d7badec6b47a7855ad07fa2063"`)
        await db.query(`ALTER TABLE "canton_market_daily_snapshot" DROP CONSTRAINT "FK_22f1f9dc2d2e46136f426652727"`)
        await db.query(`ALTER TABLE "canton_market" DROP CONSTRAINT "FK_49b116226e02291b4c8dcce4e5f"`)
        await db.query(`ALTER TABLE "canton_market" DROP CONSTRAINT "FK_9593e652ba49b368c57eae9b2e6"`)

        await db.query(`DROP TABLE "canton_indexer_state"`)
        await db.query(`DROP TABLE "canton_market_lineage"`)
        await db.query(`DROP TABLE "canton_market_hourly_snapshot"`)
        await db.query(`DROP TABLE "canton_market_daily_snapshot"`)
        await db.query(`DROP TABLE "canton_market"`)
        await db.query(`DROP TABLE "token"`)
    }
}
