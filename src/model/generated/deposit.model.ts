import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, IntColumn as IntColumn_, ManyToOne as ManyToOne_, Index as Index_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_} from "@subsquid/typeorm-store"
import {LendingProtocol} from "./lendingProtocol.model"
import {Account} from "./account.model"
import {Market} from "./market.model"
import {Token} from "./token.model"

@Entity_()
export class Deposit {
    constructor(props?: Partial<Deposit>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    hash!: string

    @IntColumn_({nullable: false})
    logIndex!: number

    @Index_()
    @ManyToOne_(() => LendingProtocol, {nullable: true})
    protocol!: LendingProtocol

    @Index_()
    @ManyToOne_(() => Account, {nullable: true})
    account!: Account

    @Index_()
    @ManyToOne_(() => Market, {nullable: true})
    market!: Market

    @BigIntColumn_({nullable: false})
    blockNumber!: bigint

    @BigIntColumn_({nullable: false})
    timestamp!: bigint

    @Index_()
    @ManyToOne_(() => Token, {nullable: true})
    asset!: Token

    @BigIntColumn_({nullable: false})
    amount!: bigint

    @BigDecimalColumn_({nullable: false})
    amountUSD!: BigDecimal

    @BigIntColumn_({nullable: false})
    shares!: bigint

    @StringColumn_({nullable: false})
    onBehalf!: string
}
