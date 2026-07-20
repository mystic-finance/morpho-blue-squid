import * as p from '@subsquid/evm-codec'
import { event, fun, viewFun, indexed, ContractBase } from '@subsquid/evm-abi'
import type { EventParams as EParams, FunctionArguments, FunctionReturn } from '@subsquid/evm-abi'

export const functions = {
    price: viewFun("0xa035b1fe", "price()", {}, p.uint256),
}

export class Contract extends ContractBase {

    price() {
        return this.eth_call(functions.price, {})
    }
}

/// Function types
export type PriceParams = FunctionArguments<typeof functions.price>
export type PriceReturn = FunctionReturn<typeof functions.price>

