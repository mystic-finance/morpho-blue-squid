import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_, BooleanColumn as BooleanColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {CantonMarket} from "./cantonMarket.model"
import {CantonPositionLineage} from "./cantonPositionLineage.model"

@Entity_()
export class CantonPosition {
    constructor(props?: Partial<CantonPosition>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    currentContractId!: string

    @Index_()
    @ManyToOne_(() => CantonMarket, {nullable: true})
    market!: CantonMarket

    @StringColumn_({nullable: false})
    marketId!: string

    @StringColumn_({nullable: false})
    owner!: string

    @StringColumn_({nullable: false})
    provider!: string

    @BigIntColumn_({nullable: false})
    collateralAmount!: bigint

    @BigIntColumn_({nullable: false})
    borrowShares!: bigint

    @BigIntColumn_({nullable: false})
    lltv!: bigint

    @BigIntColumn_({nullable: false})
    borrowAssets!: bigint

    @BooleanColumn_({nullable: false})
    liquidatable!: boolean

    @BigIntColumn_({nullable: false})
    lastUpdate!: bigint

    @OneToMany_(() => CantonPositionLineage, e => e.position)
    lineage!: CantonPositionLineage[]
}
