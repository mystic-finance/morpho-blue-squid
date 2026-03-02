import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, BooleanColumn as BooleanColumn_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_} from "@subsquid/typeorm-store"
import {Account} from "./account.model"
import {Market} from "./market.model"
import {PositionSide} from "./_positionSide"

@Entity_()
export class Position {
    constructor(props?: Partial<Position>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Account, {nullable: true})
    account!: Account

    @Index_()
    @ManyToOne_(() => Market, {nullable: true})
    market!: Market

    @Column_("varchar", {length: 10, nullable: false})
    side!: PositionSide

    @BooleanColumn_({nullable: false})
    isCollateral!: boolean

    @BigIntColumn_({nullable: false})
    balance!: bigint

    @BigDecimalColumn_({nullable: false})
    balanceUSD!: BigDecimal

    @BooleanColumn_({nullable: false})
    isActive!: boolean

    @BigIntColumn_({nullable: false})
    timestampOpened!: bigint

    @BigIntColumn_({nullable: true})
    timestampClosed!: bigint | undefined | null

    @BigIntColumn_({nullable: false})
    blockNumberOpened!: bigint

    @BigIntColumn_({nullable: true})
    blockNumberClosed!: bigint | undefined | null
}
