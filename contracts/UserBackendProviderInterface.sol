/**
* Copyright 2017–2018, LaborX PTY
* Licensed under the AGPL Version 3 license.
*/

pragma solidity ^0.4.21;


interface UserBackendProviderInterface {
	function getUserBackend() external view returns (address);
	function getUserRegistry() external view returns (address);
}