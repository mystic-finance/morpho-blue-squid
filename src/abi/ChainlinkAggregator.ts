import * as p from '@subsquid/evm-codec'
import { event, fun, viewFun, indexed, ContractBase } from '@subsquid/evm-abi'
import type { EventParams as EParams, FunctionArguments, FunctionReturn } from '@subsquid/evm-abi'

export const functions = {
    decimals: viewFun("0x313ce567", "decimals()", {}, p.uint8),
    latestRoundData: viewFun("0xfeaf968c", "latestRoundData()", {}, {"roundId": p.uint80, "answer": p.int256, "startedAt": p.uint256, "updatedAt": p.uint256, "answeredInRound": p.uint80}),
}

export class Contract extends ContractBase {

    decimals() {
        return this.eth_call(functions.decimals, {})
    }

    latestRoundData() {
        return this.eth_call(functions.latestRoundData, {})
    }
}

/// Function types
export type DecimalsParams = FunctionArguments<typeof functions.decimals>
export type DecimalsReturn = FunctionReturn<typeof functions.decimals>

export type LatestRoundDataParams = FunctionArguments<typeof functions.latestRoundData>
export type LatestRoundDataReturn = FunctionReturn<typeof functions.latestRoundData>

