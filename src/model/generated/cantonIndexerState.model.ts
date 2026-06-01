import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class CantonIndexerState {
    constructor(props?: Partial<CantonIndexerState>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    lastOffset!: string

    @BigIntColumn_({nullable: false})
    lastEventTime!: bigint

    @BigIntColumn_({nullable: false})
    eventsProcessed!: bigint

    @BigIntColumn_({nullable: false})
    updatedAt!: bigint
}
