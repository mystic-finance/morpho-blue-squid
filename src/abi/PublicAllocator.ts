import * as p from '@subsquid/evm-codec'
import { event, fun, viewFun, indexed, ContractBase } from '@subsquid/evm-abi'
import type { EventParams as EParams, FunctionArguments, FunctionReturn } from '@subsquid/evm-abi'

export const events = {
    SetFlowCaps: event("0x709e1cb4b0ac458eb1c1a9c708e841ee963b229247afbf1437bd39e01ae4aa14", "SetFlowCaps(address,address,(bytes32,(uint128,uint128))[])", {"sender": indexed(p.address), "vault": indexed(p.address), "config": p.array(p.struct({"id": p.bytes32, "caps": p.struct({"maxIn": p.uint128, "maxOut": p.uint128})}))}),
    PublicWithdrawal: event("0x6218cdb9e8efb3d0e8136d32c91d9446eaf19e2e486bc67dfcb3d574ca60d504", "PublicWithdrawal(address,address,bytes32,uint256)", {"sender": indexed(p.address), "vault": indexed(p.address), "withdrawnMarketId": indexed(p.bytes32), "withdrawnAssets": p.uint256}),
    PublicReallocateTo: event("0xf8ae80b0854dfc3c73d3eb4b6160df1996a5859e6c1d11d10f3980a7f4691991", "PublicReallocateTo(address,address,bytes32,uint256)", {"sender": indexed(p.address), "vault": indexed(p.address), "supplyMarketId": indexed(p.bytes32), "suppliedAssets": p.uint256}),
    SetFee: event("0x44a6d70a601a6f8a85c075467e9d7245897140cbf6dd505c9d9d764459f5fb64", "SetFee(address,address,uint256)", {"sender": indexed(p.address), "vault": indexed(p.address), "fee": p.uint256}),
}

export const functions = {
    flowCaps: viewFun("0x9dbcd5b9", "flowCaps(address,bytes32)", {"vault": p.address, "id": p.bytes32}, {"maxIn": p.uint128, "maxOut": p.uint128}),
    fee: viewFun("0x6fcca69b", "fee(address)", {"vault": p.address}, p.uint256),
}

export class Contract extends ContractBase {

    flowCaps(vault: FlowCapsParams["vault"], id: FlowCapsParams["id"]) {
        return this.eth_call(functions.flowCaps, {vault, id})
    }

    fee(vault: FeeParams["vault"]) {
        return this.eth_call(functions.fee, {vault})
    }
}

/// Event types
export type SetFlowCapsEventArgs = EParams<typeof events.SetFlowCaps>
export type PublicWithdrawalEventArgs = EParams<typeof events.PublicWithdrawal>
export type PublicReallocateToEventArgs = EParams<typeof events.PublicReallocateTo>
export type SetFeeEventArgs = EParams<typeof events.SetFee>

/// Function types
export type FlowCapsParams = FunctionArguments<typeof functions.flowCaps>
export type FlowCapsReturn = FunctionReturn<typeof functions.flowCaps>

export type FeeParams = FunctionArguments<typeof functions.fee>
export type FeeReturn = FunctionReturn<typeof functions.fee>

