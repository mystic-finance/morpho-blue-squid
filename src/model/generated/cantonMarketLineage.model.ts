import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {CantonMarket} from "./cantonMarket.model"

@Entity_()
export class CantonMarketLineage {
    constructor(props?: Partial<CantonMarketLineage>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => CantonMarket, {nullable: true})
    market!: CantonMarket

    @BigIntColumn_({nullable: false})
    firstSeen!: bigint

    @BigIntColumn_({nullable: false})
    lastSeen!: bigint

    @BigIntColumn_({nullable: true})
    archivedAt!: bigint | undefined | null
}
