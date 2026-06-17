import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {CantonPosition} from "./cantonPosition.model"

@Entity_()
export class CantonPositionLineage {
    constructor(props?: Partial<CantonPositionLineage>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => CantonPosition, {nullable: true})
    position!: CantonPosition

    @BigIntColumn_({nullable: false})
    firstSeen!: bigint

    @BigIntColumn_({nullable: false})
    lastSeen!: bigint

    @BigIntColumn_({nullable: true})
    archivedAt!: bigint | undefined | null
}
