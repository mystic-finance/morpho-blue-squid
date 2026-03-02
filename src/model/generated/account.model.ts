import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, IntColumn as IntColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Position} from "./position.model"

@Entity_()
export class Account {
    constructor(props?: Partial<Account>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @IntColumn_({nullable: false})
    positionCount!: number

    @IntColumn_({nullable: false})
    openPositionCount!: number

    @IntColumn_({nullable: false})
    closedPositionCount!: number

    @OneToMany_(() => Position, e => e.account)
    positions!: Position[]
}
