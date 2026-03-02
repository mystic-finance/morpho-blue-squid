import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, StringColumn as StringColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {VaultV2} from "./vaultV2.model"

@Entity_()
export class VaultV2Allocation {
    constructor(props?: Partial<VaultV2Allocation>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => VaultV2, {nullable: true})
    vault!: VaultV2

    @StringColumn_({nullable: false})
    adapter!: string

    @StringColumn_({nullable: false})
    marketId!: string

    @BigIntColumn_({nullable: false})
    absoluteCap!: bigint

    @BigIntColumn_({nullable: false})
    relativeCap!: bigint
}
