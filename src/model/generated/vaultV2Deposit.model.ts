import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_, StringColumn as StringColumn_} from "@subsquid/typeorm-store"
import {VaultV2} from "./vaultV2.model"
import {Account} from "./account.model"

@Entity_()
export class VaultV2Deposit {
    constructor(props?: Partial<VaultV2Deposit>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => VaultV2, {nullable: true})
    vault!: VaultV2

    @Index_()
    @ManyToOne_(() => Account, {nullable: true})
    sender!: Account

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
