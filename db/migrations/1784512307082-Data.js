module.exports = class Data1784512307082 {
    name = 'Data1784512307082'

    async up(db) {
        await db.query(`CREATE TABLE IF NOT EXISTS "public_allocator_flow_cap" ("id" character varying NOT NULL, "max_in" numeric NOT NULL, "max_out" numeric NOT NULL, "last_update" numeric NOT NULL, "vault_id" character varying, "market_id" character varying, CONSTRAINT "PK_a33ededd99b1a1b9915863890da" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_6e417030180fd697ae34b08382" ON "public_allocator_flow_cap" ("vault_id") `)
        await db.query(`CREATE INDEX IF NOT EXISTS "IDX_f3e9843495facda5c843547443" ON "public_allocator_flow_cap" ("market_id") `)
        await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_6e417030180fd697ae34b08382b') THEN EXECUTE $sql$ALTER TABLE "public_allocator_flow_cap" ADD CONSTRAINT "FK_6e417030180fd697ae34b08382b" FOREIGN KEY ("vault_id") REFERENCES "meta_morpho"("id") ON DELETE NO ACTION ON UPDATE NO ACTION$sql$; END IF; END $$`)
        await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_f3e9843495facda5c843547443d') THEN EXECUTE $sql$ALTER TABLE "public_allocator_flow_cap" ADD CONSTRAINT "FK_f3e9843495facda5c843547443d" FOREIGN KEY ("market_id") REFERENCES "market"("id") ON DELETE NO ACTION ON UPDATE NO ACTION$sql$; END IF; END $$`)
    }

    async down(db) {
        await db.query(`DROP TABLE "public_allocator_flow_cap"`)
        await db.query(`DROP INDEX "public"."IDX_6e417030180fd697ae34b08382"`)
        await db.query(`DROP INDEX "public"."IDX_f3e9843495facda5c843547443"`)
        await db.query(`ALTER TABLE "public_allocator_flow_cap" DROP CONSTRAINT "FK_6e417030180fd697ae34b08382b"`)
        await db.query(`ALTER TABLE "public_allocator_flow_cap" DROP CONSTRAINT "FK_f3e9843495facda5c843547443d"`)
    }
}
