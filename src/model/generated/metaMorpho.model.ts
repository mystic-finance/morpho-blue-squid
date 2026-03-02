import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Token} from "./token.model"
import {Account} from "./account.model"
import {MetaMorphoMarketAllocation} from "./metaMorphoMarketAllocation.model"
import {MetaMorphoMarketWithdrawAllocation} from "./metaMorphoMarketWithdrawAllocation.model"
import {MetaMorphoPosition} from "./metaMorphoPosition.model"
import {MetaMorphoDailySnapshot} from "./metaMorphoDailySnapshot.model"
import {MetaMorphoHourlySnapshot} from "./metaMorphoHourlySnapshot.model"

@Entity_()
export class MetaMorpho {
    constructor(props?: Partial<MetaMorpho>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    name!: string

    @StringColumn_({nullable: false})
    symbol!: string

    @Index_()
    @ManyToOne_(() => Token, {nullable: true})
    asset!: Token

    @Index_()
    @ManyToOne_(() => Account, {nullable: true})
    owner!: Account

    @Index_()
    @ManyToOne_(() => Account, {nullable: true})
    curator!: Account | undefined | null

    @BigIntColumn_({nullable: false})
    fee!: bigint

    @StringColumn_({nullable: true})
    feeRecipient!: string | undefined | null

    @BigIntColumn_({nullable: false})
    timelock!: bigint

    @BigIntColumn_({nullable: false})
    totalAssets!: bigint

    @BigIntColumn_({nullable: false})
    totalSupply!: bigint

    @BigDecimalColumn_({nullable: false})
    totalAssetsUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    apy!: BigDecimal

    @BigIntColumn_({nullable: false})
    lastTotalAssets!: bigint

    @BigIntColumn_({nullable: false})
    lastTotalAssetsTimestamp!: bigint

    @OneToMany_(() => MetaMorphoMarketAllocation, e => e.vault)
    supplyQueue!: MetaMorphoMarketAllocation[]

    @OneToMany_(() => MetaMorphoMarketWithdrawAllocation, e => e.vault)
    withdrawQueue!: MetaMorphoMarketWithdrawAllocation[]

    @OneToMany_(() => MetaMorphoPosition, e => e.vault)
    positions!: MetaMorphoPosition[]

    @OneToMany_(() => MetaMorphoDailySnapshot, e => e.vault)
    dailySnapshots!: MetaMorphoDailySnapshot[]

    @OneToMany_(() => MetaMorphoHourlySnapshot, e => e.vault)
    hourlySnapshots!: MetaMorphoHourlySnapshot[]
}
