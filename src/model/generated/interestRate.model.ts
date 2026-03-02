import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, BigDecimalColumn as BigDecimalColumn_} from "@subsquid/typeorm-store"
import {Market} from "./market.model"
import {InterestRateSide} from "./_interestRateSide"
import {InterestRateType} from "./_interestRateType"

@Entity_()
export class InterestRate {
    constructor(props?: Partial<InterestRate>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Market, {nullable: true})
    market!: Market

    @BigDecimalColumn_({nullable: false})
    rate!: BigDecimal

    @Column_("varchar", {length: 8, nullable: false})
    side!: InterestRateSide

    @Column_("varchar", {length: 8, nullable: false})
    type!: InterestRateType
}
