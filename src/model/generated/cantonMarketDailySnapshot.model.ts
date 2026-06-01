import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_} from "@subsquid/typeorm-store"
import {CantonMarket} from "./cantonMarket.model"

@Entity_()
export class CantonMarketDailySnapshot {
    constructor(props?: Partial<CantonMarketDailySnapshot>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => CantonMarket, {nullable: true})
    market!: CantonMarket

    @IntColumn_({nullable: false})
    dayId!: number

    @BigIntColumn_({nullable: false})
    timestamp!: bigint

    @BigIntColumn_({nullable: false})
    totalSupplyAssets!: bigint

    @BigIntColumn_({nullable: false})
    totalSupplyShares!: bigint

    @BigIntColumn_({nullable: false})
    totalBorrowAssets!: bigint

    @BigIntColumn_({nullable: false})
    totalBorrowShares!: bigint

    @BigDecimalColumn_({nullable: false})
    borrowAPY!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    supplyAPY!: BigDecimal
}
