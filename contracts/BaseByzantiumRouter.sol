/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 */

pragma solidity ^0.4.11;


/// @title Routing contract that is able to provide a way for delegating invocations with dynamic destination address.
contract BaseByzantiumRouter {

    function() 
    payable 
    external 
    {
        address _implementation = implementation();

        assembly {
            let calldataMemoryOffset := mload(0x40)
            mstore(0x40, add(calldataMemoryOffset, calldatasize))
            calldatacopy(calldataMemoryOffset, 0x0, calldatasize)
            let r := delegatecall(sub(gas, 10000), _implementation, calldataMemoryOffset, calldatasize, 0, 0)

            let returndataMemoryOffset := mload(0x40)
            mstore(0x40, add(returndataMemoryOffset, returndatasize))
            returndatacopy(returndataMemoryOffset, 0x0, returndatasize)

            switch r
            case 1 {
                return(returndataMemoryOffset, returndatasize)
            }
            default {
                revert(0, 0)
            }
        }
    }

    /// @notice Returns destination address for future calls
    /// @dev abstract definition. should be implemented in sibling contracts
    /// @return destination address
    function implementation() internal view returns (address);
}
