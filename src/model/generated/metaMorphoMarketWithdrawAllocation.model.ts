import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_} from "@subsquid/typeorm-store"
import {MetaMorpho} from "./metaMorpho.model"
import {Market} from "./market.model"

@Entity_()
export class MetaMorphoMarketWithdrawAllocation {
    constructor(props?: Partial<MetaMorphoMarketWithdrawAllocation>) {
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
}
