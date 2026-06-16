import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class CantonOracle {
    constructor(props?: Partial<CantonOracle>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @BigIntColumn_({nullable: true})
    price!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    priceUpdatedAt!: bigint | undefined | null
}
