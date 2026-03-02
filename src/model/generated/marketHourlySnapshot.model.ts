import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_} from "@subsquid/typeorm-store"
import {Market} from "./market.model"

@Entity_()
export class MarketHourlySnapshot {
    constructor(props?: Partial<MarketHourlySnapshot>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Market, {nullable: true})
    market!: Market

    @IntColumn_({nullable: false})
    hourId!: number

    @BigIntColumn_({nullable: false})
    blockNumber!: bigint

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
    totalValueLockedUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    totalDepositBalanceUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    totalBorrowBalanceUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    borrowAPY!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    supplyAPY!: BigDecimal
}
