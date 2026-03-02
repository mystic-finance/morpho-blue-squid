import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, StringColumn as StringColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {MetaMorpho} from "./metaMorpho.model"
import {Account} from "./account.model"

@Entity_()
export class MetaMorphoWithdraw {
    constructor(props?: Partial<MetaMorphoWithdraw>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => MetaMorpho, {nullable: true})
    vault!: MetaMorpho

    @Index_()
    @ManyToOne_(() => Account, {nullable: true})
    sender!: Account

    @StringColumn_({nullable: false})
    receiver!: string

    @Index_()
    @ManyToOne_(() => Account, {nullable: true})
    owner!: Account

    @BigIntColumn_({nullable: false})
    assets!: bigint

    @BigIntColumn_({nullable: false})
    shares!: bigint

    @BigIntColumn_({nullable: false})
    blockNumber!: bigint

    @BigIntColumn_({nullable: false})
    timestamp!: bigint

    @StringColumn_({nullable: false})
    hash!: string
}
