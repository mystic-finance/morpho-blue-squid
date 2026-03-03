import * as p from '@subsquid/evm-codec'
import { event, fun, viewFun, indexed, ContractBase } from '@subsquid/evm-abi'
import type { EventParams as EParams, FunctionArguments, FunctionReturn } from '@subsquid/evm-abi'

export const events = {
    Deposit: event("0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7", "Deposit(address,address,uint256,uint256)", {"sender": indexed(p.address), "owner": indexed(p.address), "assets": p.uint256, "shares": p.uint256}),
    Withdraw: event("0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db", "Withdraw(address,address,address,uint256,uint256)", {"sender": indexed(p.address), "receiver": indexed(p.address), "owner": indexed(p.address), "assets": p.uint256, "shares": p.uint256}),
    SetCurator: event("0xbd0a63c12948fbc9194a5839019f99c9d71db924e5c70018265bc778b8f1a506", "SetCurator(address)", {"newCurator": indexed(p.address)}),
    IncreaseAbsoluteCap: event("0xf01464e060b07fa42a4ef6f7884fdc80c96e62d560730b6bda9201411d3495cd", "IncreaseAbsoluteCap(bytes32,uint256)", {"id": indexed(p.bytes32), "newAbsoluteCap": p.uint256}),
    DecreaseAbsoluteCap: event("0xf3d853fbf7b11a0d1fe4ae9bef9809aeffa7f8d470007ed028838578d6d944eb", "DecreaseAbsoluteCap(bytes32,uint256)", {"id": indexed(p.bytes32), "newAbsoluteCap": p.uint256}),
    IncreaseRelativeCap: event("0x1d6d8d4fa66ff23483cfa329e51386d78e8e874abe33d3813c2038a7005148a2", "IncreaseRelativeCap(bytes32,uint256)", {"id": indexed(p.bytes32), "newRelativeCap": p.uint256}),
    Allocate: event("0xb291c5cc9f544afb4a1971c607995d326287d649987b0386427190f645fe3554", "Allocate(address,address,uint256,bytes32,int256)", {"sender": indexed(p.address), "adapter": indexed(p.address), "assets": p.uint256, "ids": p.bytes32, "change": p.int256}),
    Deallocate: event("0xa3c513ad4b1395f38dbf6992f28fa32588ed54e2a1abd7894fe335e98d7f0da9", "Deallocate(address,address,uint256,bytes32,int256)", {"sender": indexed(p.address), "adapter": indexed(p.address), "assets": p.uint256, "ids": p.bytes32, "change": p.int256}),
    Transfer: event("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "Transfer(address,address,uint256)", {"from": indexed(p.address), "to": indexed(p.address), "value": p.uint256}),
}

export const functions = {
    name: viewFun("0x06fdde03", "name()", {}, p.string),
    symbol: viewFun("0x95d89b41", "symbol()", {}, p.string),
    asset: viewFun("0x38d52e0f", "asset()", {}, p.address),
    owner: viewFun("0x8da5cb5b", "owner()", {}, p.address),
    curator: viewFun("0xe66f53b7", "curator()", {}, p.address),
    totalAssets: viewFun("0x01e1d114", "totalAssets()", {}, p.uint256),
    totalSupply: viewFun("0x18160ddd", "totalSupply()", {}, p.uint256),
    adapterRegistry: viewFun("0x50b5c16a", "adapterRegistry()", {}, p.address),
    adapterLength: viewFun("0xf4a599ac", "adapterLength()", {}, p.uint256),
    adapters: viewFun("0x4ef501ac", "adapters(uint256)", {"_0": p.uint256}, p.address),
}

export class Contract extends ContractBase {

    name() {
        return this.eth_call(functions.name, {})
    }

    symbol() {
        return this.eth_call(functions.symbol, {})
    }

    asset() {
        return this.eth_call(functions.asset, {})
    }

    owner() {
        return this.eth_call(functions.owner, {})
    }

    curator() {
        return this.eth_call(functions.curator, {})
    }

    totalAssets() {
        return this.eth_call(functions.totalAssets, {})
    }

    totalSupply() {
        return this.eth_call(functions.totalSupply, {})
    }

    adapterRegistry() {
        return this.eth_call(functions.adapterRegistry, {})
    }

    adapterLength() {
        return this.eth_call(functions.adapterLength, {})
    }

    adapters(_0: AdaptersParams["_0"]) {
        return this.eth_call(functions.adapters, {_0})
    }
}

/// Event types
export type DepositEventArgs = EParams<typeof events.Deposit>
export type WithdrawEventArgs = EParams<typeof events.Withdraw>
export type SetCuratorEventArgs = EParams<typeof events.SetCurator>
export type IncreaseAbsoluteCapEventArgs = EParams<typeof events.IncreaseAbsoluteCap>
export type DecreaseAbsoluteCapEventArgs = EParams<typeof events.DecreaseAbsoluteCap>
export type IncreaseRelativeCapEventArgs = EParams<typeof events.IncreaseRelativeCap>
export type AllocateEventArgs = EParams<typeof events.Allocate>
export type DeallocateEventArgs = EParams<typeof events.Deallocate>
export type TransferEventArgs = EParams<typeof events.Transfer>

/// Function types
export type NameParams = FunctionArguments<typeof functions.name>
export type NameReturn = FunctionReturn<typeof functions.name>

export type SymbolParams = FunctionArguments<typeof functions.symbol>
export type SymbolReturn = FunctionReturn<typeof functions.symbol>

export type AssetParams = FunctionArguments<typeof functions.asset>
export type AssetReturn = FunctionReturn<typeof functions.asset>

export type OwnerParams = FunctionArguments<typeof functions.owner>
export type OwnerReturn = FunctionReturn<typeof functions.owner>

export type CuratorParams = FunctionArguments<typeof functions.curator>
export type CuratorReturn = FunctionReturn<typeof functions.curator>

export type TotalAssetsParams = FunctionArguments<typeof functions.totalAssets>
export type TotalAssetsReturn = FunctionReturn<typeof functions.totalAssets>

export type TotalSupplyParams = FunctionArguments<typeof functions.totalSupply>
export type TotalSupplyReturn = FunctionReturn<typeof functions.totalSupply>

export type AdapterRegistryParams = FunctionArguments<typeof functions.adapterRegistry>
export type AdapterRegistryReturn = FunctionReturn<typeof functions.adapterRegistry>

export type AdapterLengthParams = FunctionArguments<typeof functions.adapterLength>
export type AdapterLengthReturn = FunctionReturn<typeof functions.adapterLength>

export type AdaptersParams = FunctionArguments<typeof functions.adapters>
export type AdaptersReturn = FunctionReturn<typeof functions.adapters>

