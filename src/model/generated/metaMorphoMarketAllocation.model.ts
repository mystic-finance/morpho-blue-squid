import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_, BooleanColumn as BooleanColumn_} from "@subsquid/typeorm-store"
import {MetaMorpho} from "./metaMorpho.model"
import {Market} from "./market.model"

@Entity_()
export class MetaMorphoMarketAllocation {
    constructor(props?: Partial<MetaMorphoMarketAllocation>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => MetaMorpho, {nullable: true})
    vault!: MetaMorpho

    @Index_()
    @ManyToOne_(() => Market, {nullable: true})
    market!: Market

    @BigIntColumn_({nullable: false})
    cap!: bigint

    @BooleanColumn_({nullable: false})
    enabled!: boolean
}
