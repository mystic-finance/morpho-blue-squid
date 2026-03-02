import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, BigDecimalColumn as BigDecimalColumn_, IntColumn as IntColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Market} from "./market.model"

@Entity_()
export class LendingProtocol {
    constructor(props?: Partial<LendingProtocol>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    name!: string

    @StringColumn_({nullable: false})
    slug!: string

    @StringColumn_({nullable: false})
    schemaVersion!: string

    @StringColumn_({nullable: false})
    subgraphVersion!: string

    @StringColumn_({nullable: false})
    methodologyVersion!: string

    @StringColumn_({nullable: false})
    network!: string

    @StringColumn_({nullable: false})
    type!: string

    @StringColumn_({nullable: true})
    lendingType!: string | undefined | null

    @BigDecimalColumn_({nullable: false})
    totalValueLockedUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    totalBorrowBalanceUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    totalDepositBalanceUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    cumulativeBorrowUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    cumulativeDepositUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    cumulativeLiquidateUSD!: BigDecimal

    @IntColumn_({nullable: false})
    totalPoolCount!: number

    @IntColumn_({nullable: false})
    openPositionCount!: number

    @IntColumn_({nullable: false})
    cumulativePositionCount!: number

    @OneToMany_(() => Market, e => e.protocol)
    markets!: Market[]
}
