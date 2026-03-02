import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Token} from "./token.model"
import {Account} from "./account.model"
import {VaultV2Position} from "./vaultV2Position.model"
import {VaultV2Allocation} from "./vaultV2Allocation.model"
import {VaultV2DailySnapshot} from "./vaultV2DailySnapshot.model"
import {VaultV2HourlySnapshot} from "./vaultV2HourlySnapshot.model"

@Entity_()
export class VaultV2 {
    constructor(props?: Partial<VaultV2>) {
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

    @OneToMany_(() => VaultV2Position, e => e.vault)
    positions!: VaultV2Position[]

    @OneToMany_(() => VaultV2Allocation, e => e.vault)
    allocations!: VaultV2Allocation[]

    @OneToMany_(() => VaultV2DailySnapshot, e => e.vault)
    dailySnapshots!: VaultV2DailySnapshot[]

    @OneToMany_(() => VaultV2HourlySnapshot, e => e.vault)
    hourlySnapshots!: VaultV2HourlySnapshot[]
}
