import {BigDecimal} from "@subsquid/big-decimal"
import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, StringColumn as StringColumn_, BooleanColumn as BooleanColumn_, BigIntColumn as BigIntColumn_, BigDecimalColumn as BigDecimalColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {LendingProtocol} from "./lendingProtocol.model"
import {Token} from "./token.model"
import {InterestRate} from "./interestRate.model"
import {Position} from "./position.model"
import {Deposit} from "./deposit.model"
import {Withdraw} from "./withdraw.model"
import {Borrow} from "./borrow.model"
import {Repay} from "./repay.model"
import {Liquidate} from "./liquidate.model"

@Entity_()
export class Market {
    constructor(props?: Partial<Market>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => LendingProtocol, {nullable: true})
    protocol!: LendingProtocol

    @StringColumn_({nullable: false})
    name!: string

    @BooleanColumn_({nullable: false})
    isActive!: boolean

    @Index_()
    @ManyToOne_(() => Token, {nullable: true})
    inputToken!: Token

    @Index_()
    @ManyToOne_(() => Token, {nullable: true})
    borrowedToken!: Token

    @StringColumn_({nullable: false})
    oracle!: string

    @StringColumn_({nullable: false})
    irm!: string

    @BigIntColumn_({nullable: false})
    lltv!: bigint

    @BigDecimalColumn_({nullable: false})
    totalValueLockedUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    totalDepositBalanceUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    totalBorrowBalanceUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    cumulativeDepositUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    cumulativeBorrowUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    cumulativeLiquidateUSD!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    maximumLTV!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    liquidationThreshold!: BigDecimal

    @BigDecimalColumn_({nullable: false})
    liquidationPenalty!: BigDecimal

    @BigIntColumn_({nullable: false})
    totalSupplyAssets!: bigint

    @BigIntColumn_({nullable: false})
    totalSupplyShares!: bigint

    @BigIntColumn_({nullable: false})
    totalBorrowAssets!: bigint

    @BigIntColumn_({nullable: false})
    totalBorrowShares!: bigint

    @BigIntColumn_({nullable: false})
    lastUpdate!: bigint

    @BigIntColumn_({nullable: false})
    fee!: bigint

    @OneToMany_(() => InterestRate, e => e.market)
    rates!: InterestRate[]

    @OneToMany_(() => Position, e => e.market)
    positions!: Position[]

    @OneToMany_(() => Deposit, e => e.market)
    deposits!: Deposit[]

    @OneToMany_(() => Withdraw, e => e.market)
    withdraws!: Withdraw[]

    @OneToMany_(() => Borrow, e => e.market)
    borrows!: Borrow[]

    @OneToMany_(() => Repay, e => e.market)
    repays!: Repay[]

    @OneToMany_(() => Liquidate, e => e.market)
    liquidates!: Liquidate[]
}
