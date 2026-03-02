import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_} from "@subsquid/typeorm-store"
import {MetaMorpho} from "./metaMorpho.model"

@Entity_()
export class MetaMorphoDailySnapshot {
    constructor(props?: Partial<MetaMorphoDailySnapshot>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => MetaMorpho, {nullable: true})
    vault!: MetaMorpho

    @IntColumn_({nullable: false})
    dayId!: number

    @BigIntColumn_({nullable: false})
    blockNumber!: bigint

    @BigIntColumn_({nullable: false})
    timestamp!: bigint

    @BigIntColumn_({nullable: false})
    totalAssets!: bigint

    @BigIntColumn_({nullable: false})
    totalSupply!: bigint

    @BigDecimalColumn_({nullable: false})
    totalAssetsUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    apy!: BigDecimal
}
