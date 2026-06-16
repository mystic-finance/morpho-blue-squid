import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Token} from "./token.model"
import {CantonMarketLineage} from "./cantonMarketLineage.model"
import {CantonPosition} from "./cantonPosition.model"
import {CantonMarketDailySnapshot} from "./cantonMarketDailySnapshot.model"
import {CantonMarketHourlySnapshot} from "./cantonMarketHourlySnapshot.model"

@Entity_()
export class CantonMarket {
    constructor(props?: Partial<CantonMarket>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    marketId!: string

    @StringColumn_({nullable: false})
    marketCid!: string

    @Index_()
    @ManyToOne_(() => Token, {nullable: true})
    loanToken!: Token

    @Index_()
    @ManyToOne_(() => Token, {nullable: true})
    collateralToken!: Token

    @StringColumn_({nullable: false})
    irm!: string

    @BigIntColumn_({nullable: false})
    lltv!: bigint

    @BigIntColumn_({nullable: false})
    fee!: bigint

    @BigIntColumn_({nullable: false})
    totalSupplyAssets!: bigint

    @BigIntColumn_({nullable: false})
    totalSupplyShares!: bigint

    @BigIntColumn_({nullable: false})
    totalBorrowAssets!: bigint

    @BigIntColumn_({nullable: false})
    totalBorrowShares!: bigint

    @BigIntColumn_({nullable: true})
    oraclePrice!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    priceUpdatedAt!: bigint | undefined | null

    @BigDecimalColumn_({nullable: false})
    borrowAPY!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    supplyAPY!: BigDecimal

    @BigIntColumn_({nullable: false})
    lastUpdate!: bigint

    @OneToMany_(() => CantonMarketLineage, e => e.market)
    lineage!: CantonMarketLineage[]

    @OneToMany_(() => CantonPosition, e => e.market)
    positions!: CantonPosition[]

    @OneToMany_(() => CantonMarketDailySnapshot, e => e.market)
    dailySnapshots!: CantonMarketDailySnapshot[]

    @OneToMany_(() => CantonMarketHourlySnapshot, e => e.market)
    hourlySnapshots!: CantonMarketHourlySnapshot[]
}
