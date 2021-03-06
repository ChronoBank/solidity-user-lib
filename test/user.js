"use strict"

const UserBackend = artifacts.require("UserBackend")
const UserRegistry = artifacts.require("UserRegistry")
const UserBackendProvider = artifacts.require("UserBackendProvider")
const BumpedUserBackend = artifacts.require("BumpedUserBackend")
const UserRouter = artifacts.require("UserRouter")
const UserProxy = artifacts.require("UserProxy")
const UserFactory = artifacts.require("UserFactory")
const UserInterface = artifacts.require("UserInterface")
const Roles2Library = artifacts.require("Roles2Library")
const Storage = artifacts.require("Storage")
const StorageManager = artifacts.require("StorageManager")
const Owned = artifacts.require("Owned")
const Mock = artifacts.require("Mock")

const Reverter = require("./helpers/reverter")
const ErrorScope = require("../common/errors")
const eventHelpers = require("./helpers/eventsHelper")
const utils = require("./helpers/utils")
const web3Utils = require("web3-utils")
const Web3Accounts = require("web3-eth-accounts")

contract("User Workflow", accounts => {

	const reverter = new Reverter(web3)
	const web3Accounts = new Web3Accounts(web3.currentProvider.address)

	const users = {
		contractOwner: accounts[0],
		user1: accounts[1],
		user2: accounts[2],
		user3: accounts[3],
		oracle: accounts[7],
		recovery: accounts[8],
	}

	const privateKeys = {
		[users.user1]: "0x2ed950bc0ff7fc1f62aa3b302437de9763d81dcde4ce58291756f84748d98ce9",
		[users.user2]: "0xdaeb307eb13b4717d01d9f175ea3ed94374da8fefa52082379d2955579ce628a",
		[users.oracle]: "0x1e3816bb73ad4a70ea3e7606f930e2d2d492ab9d5c26776656191b1be2ae0204",
	}

	const contracts = {
		storage: null,
		storageManager: null,
		userBackend: null,
		userRegistry: null,
		userBackendProvider: null,
		userFactory: null,
		rolesLibrary: null,
		mock: null,
	}

	const assertExpectations = async (expected = 0, callsCount = null) => {
		assert.equal(
			(await contracts.mock.expectationsLeft()).toString(16),
			expected.toString(16)
		)

		const expectationsCount = await contracts.mock.expectationsCount()
		assert.equal(
			(await contracts.mock.callsCount()).toString(16),
			callsCount === null ? expectationsCount.toString(16) : callsCount.toString(16)
		)
	}

	const assertNoMultisigPresence = async tx => {
		const notEmittedEvents = [
			"Confirmation",
			"Submission",
			"Execution",
		]
		const events = await eventHelpers.findEvents([contracts.userBackend,], tx, e => notEmittedEvents.indexOf(e) >= 0)
		assert.lengthOf(events, 0)
	}

	/// @return transactionId
	const assertMultisigSubmitPresence = async ({ tx, userProxy, user, }) => {
		let transactionId
		{
			const notEmittedEvents = [
				"Execution",
				"Forwarded",
			]
			const events = await eventHelpers.findEvents([ userProxy, contracts.userBackend, ], tx, e => notEmittedEvents.indexOf(e) >= 0)
			assert.lengthOf(events, 0)
		}
		{
			{
				const event = (await eventHelpers.findEvent([contracts.userBackend,], tx, "Submission"))[0]
				assert.isDefined(event)
				assert.isDefined(event.args.transactionId)

				transactionId = event.args.transactionId
			}
			{
				const event = (await eventHelpers.findEvent([contracts.userBackend,], tx, "Confirmation"))[0]
				assert.isDefined(event)
				assert.equal(event.args.sender, user)
				assert.equal(event.args.transactionId.toString(16), transactionId.toString(16))
			}
		}

		return transactionId
	}

	const assertMultisigExecutionPresence = async ({
		tx, transactionId, userRouter, oracle,
	}) => {
		{
			const notEmittedEvents = [
				"Submission",
			]
			const events = await eventHelpers.findEvents([ userRouter, contracts.userBackend, ], tx, e => notEmittedEvents.indexOf(e) >= 0)
			assert.lengthOf(events, 0)
		}
		{
			{
				const event = (await eventHelpers.findEvent([contracts.userBackend,], tx, "Confirmation"))[0]
				assert.isDefined(event)
				assert.equal(event.args.sender, oracle)
				assert.equal(event.args.transactionId.toString(16), transactionId.toString(16))
			}
			{
				const event = (await eventHelpers.findEvent([contracts.userBackend,], tx, "Execution"))[0]
				assert.isDefined(event)
				assert.equal(event.args.transactionId.toString(16), transactionId.toString(16))
			}
		}
	}

	const signMessage = ({ message, oracle, }) => {
		return web3Accounts.sign(message, privateKeys[oracle])
	}

	const getMessageFrom = ({
		pass, sender, destination, data, value,
	}) => {
		return web3Utils.soliditySha3({
			type: "bytes",
			value: pass,
		}, {
			type: "address",
			value: sender,
		}, {
			type: "address",
			value: destination,
		}, {
			type: "bytes",
			value: data,
		}, {
			type: "uint256",
			value: value,
		})
	}

	before("setup", async () => {
		await reverter.promisifySnapshot()

		contracts.storage = await Storage.new({ from: users.contractOwner, })
		contracts.storageManager = await StorageManager.new({ from: users.contractOwner, })
		await contracts.storageManager.setupEventsHistory(contracts.storageManager.address, { from: users.contractOwner, })
		await contracts.storage.setManager(contracts.storageManager.address, { from: users.contractOwner, })

		contracts.userBackend = await UserBackend.new({ from: users.contractOwner, })

		contracts.rolesLibrary = await Roles2Library.new(contracts.storage.address, "RolesLib", { from: users.contractOwner, })
		await contracts.storageManager.giveAccess(contracts.rolesLibrary.address, "RolesLib", { from: users.contractOwner, })
		await contracts.rolesLibrary.setRootUser(users.contractOwner, true, { from: users.contractOwner, })
		await contracts.rolesLibrary.setupEventsHistory(contracts.rolesLibrary.address, { from: users.contractOwner, })

		contracts.userRegistry = await UserRegistry.new(contracts.storage.address, "UserRegistry", contracts.rolesLibrary.address, { from: users.contractOwner, })
		await contracts.storageManager.giveAccess(contracts.userRegistry.address, "UserRegistry", { from: users.contractOwner, })
		await contracts.userRegistry.setupEventsHistory(contracts.userRegistry.address, { from: users.contractOwner, })

		contracts.userBackendProvider = await UserBackendProvider.new(contracts.rolesLibrary.address, { from: users.contractOwner, })
		await contracts.userBackendProvider.setUserBackend(contracts.userBackend.address, { from: users.contractOwner, })
		await contracts.userBackendProvider.setUserRegistry(contracts.userRegistry.address, { from: users.contractOwner, })

		contracts.userFactory = await UserFactory.new(contracts.rolesLibrary.address, { from: users.contractOwner, })
		await contracts.userFactory.setUserBackendProvider(contracts.userBackendProvider.address, { from: users.contractOwner, })
		await contracts.userFactory.setOracleAddress(users.oracle, { from: users.contractOwner, })
		await contracts.userFactory.setUserRecoveryAddress(users.recovery, { from: users.contractOwner, })

		contracts.mock = await Mock.new()

		// NOTE: HERE!!!! RIGHTS SHOULD BE GRANTED TO UserFactory TO ACCESS UserRegistry CONTRACT MODIFICATION
		{
			const Roles = { USER_REGISTRY_ROLE: 11, }

			await contracts.rolesLibrary.addUserRole(contracts.userFactory.address, Roles.USER_REGISTRY_ROLE, { from: users.contractOwner, })
			{
				const sig = contracts.userRegistry.contract.addUserContract.getData(0x0).slice(0,10)
				await contracts.rolesLibrary.addRoleCapability(Roles.USER_REGISTRY_ROLE, contracts.userRegistry.address, sig, { from: users.contractOwner, })
			}
		}

		await reverter.promisifySnapshot()
	})

	after(async () => {
		await reverter.promisifyRevert(0)
	})

	context("initial state of", () => {

		describe("user factory", () => {

			afterEach(async () => {
				await reverter.promisifyRevert()
			})

			it("should have pre-setup oracle", async () => {
				assert.equal(
					await contracts.userFactory.oracle(),
					users.oracle
				)
			})

			it("should have pre-setup backend provider", async () => {
				assert.equal(
					await contracts.userFactory.userBackendProvider(),
					contracts.userBackendProvider.address
				)
			})

			it("should have pre-setup recovery address", async () => {
				assert.equal(
					await contracts.userFactory.userRecoveryAddress(),
					users.recovery
				)
			})

			it("should have pre-setup events history", async () => {
				assert.equal(
					await contracts.userFactory.getEventsHistory(),
					contracts.userFactory.address
				)
			})

			it("should THROW and NOT allow to pass 0x0 for events history", async () => {
				await contracts.userFactory.setupEventsHistory(utils.zeroAddress, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should check auth when setup events history", async () => {
				const caller = users.user3
				const newEventsHistory = "0x0000ffffffffffffffffffffffffffffffff0000"

				await contracts.userFactory.setRoles2Library(contracts.mock.address)
				await contracts.mock.expect(
					contracts.userFactory.address,
					0,
					contracts.rolesLibrary.contract.canCall.getData(caller, contracts.userFactory.address, contracts.userFactory.contract.setupEventsHistory.getData(0x0).slice(0, 10)),
					await contracts.mock.convertUIntToBytes32(1)
				)

				assert.equal(
					(await contracts.userFactory.setupEventsHistory.call(newEventsHistory, { from: caller, })).toNumber(),
					ErrorScope.OK
				)

				await contracts.userFactory.setupEventsHistory(newEventsHistory, { from: caller, })
				await assertExpectations()

				assert.equal(
					await contracts.userFactory.getEventsHistory.call(),
					newEventsHistory
				)
			})

			it("should THROW and NOT allow to pass 0x0 for oracle address", async () => {
				await contracts.userFactory.setOracleAddress(utils.zeroAddress, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should check auth when set oracle address", async () => {
				const caller = users.user3
				const newOracleAddress = "0x0000ffffffffffffffffffffffffffffffff0000"

				await contracts.userFactory.setRoles2Library(contracts.mock.address)
				await contracts.mock.expect(
					contracts.userFactory.address,
					0,
					contracts.rolesLibrary.contract.canCall.getData(caller, contracts.userFactory.address, contracts.userFactory.contract.setOracleAddress.getData(0x0).slice(0, 10)),
					await contracts.mock.convertUIntToBytes32(1)
				)

				assert.equal(
					(await contracts.userFactory.setOracleAddress.call(newOracleAddress, { from: caller, })).toNumber(),
					ErrorScope.OK
				)

				await contracts.userFactory.setOracleAddress(newOracleAddress, { from: caller, })
				await assertExpectations()

				assert.equal(
					await contracts.userFactory.oracle.call(),
					newOracleAddress
				)
			})

			it("should check auth when set user recovery address", async () => {
				const caller = users.user3
				const newUserRecoveryAddress = "0x0000ffffffffffffffffffffffffffffffff0000"

				await contracts.userFactory.setRoles2Library(contracts.mock.address)
				await contracts.mock.expect(
					contracts.userFactory.address,
					0,
					contracts.rolesLibrary.contract.canCall.getData(caller, contracts.userFactory.address, contracts.userFactory.contract.setUserRecoveryAddress.getData(0x0).slice(0, 10)),
					await contracts.mock.convertUIntToBytes32(1)
				)

				assert.equal(
					(await contracts.userFactory.setUserRecoveryAddress.call(newUserRecoveryAddress, { from: caller, })).toNumber(),
					ErrorScope.OK
				)

				await contracts.userFactory.setUserRecoveryAddress(newUserRecoveryAddress, { from: caller, })
				await assertExpectations()

				assert.equal(
					await contracts.userFactory.userRecoveryAddress.call(),
					newUserRecoveryAddress
				)
			})

			it("should allow to pass 0x0 for user recovery address address", async () => {
				await contracts.userFactory.setUserRecoveryAddress(utils.zeroAddress, { from: users.contractOwner, })
				assert.equal(
					await contracts.userFactory.userRecoveryAddress.call(),
					utils.zeroAddress
				)
			})
		})

		describe("user backend", () => {

			after(async () => {
				await reverter.promisifyRevert()
			})

			it("should THROW and NOT allow to initialize UserBackend by direct call", async () => {
				await contracts.userBackend.init(users.oracle, false, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should have 0x0 user proxy property", async () => {
				assert.equal(
					await contracts.userBackend.getUserProxy(),
					utils.zeroAddress
				)
			})

			it("should have a contract owner", async () => {
				assert.equal(
					await contracts.userBackend.contractOwner(),
					users.contractOwner
				)
			})

			it("should have default values for other fields", async () => {
				assert.isFalse(await contracts.userBackend.use2FA.call())
				assert.equal(await contracts.userBackend.backendProvider.call(), utils.zeroAddress)
				assert.equal(await contracts.userBackend.issuer.call(), utils.zeroAddress)
				assert.equal(await contracts.userBackend.getUserProxy.call(), utils.zeroAddress)
			})

			it("should THROW on updating user proxy", async () => {
				const userProxy = "0xffffffffffffffffffffffffffffffffffffffff"
				await contracts.userBackend.setUserProxy(userProxy, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should THROW on updating oracle", async () => {
				const oracle = "0xffffffffffffffffffffffffffffffffffffffff"
				await contracts.userBackend.setOracle(oracle, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should THROW on updating recovery", async () => {
				const recovery = "0xffffffffffffffffffffffffffffffffffffffff"
				await contracts.userBackend.setRecoveryContract(recovery, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should THROW on trying to recover a user", async () => {
				await contracts.userBackend.recoverUser(users.user2, { from: users.recovery, }).then(assert.fail, () => true)
			})

			it("should THROW on getting oracle", async () => {
				await contracts.userBackend.getOracle.call().then(assert.fail, () => true)
			})

			it("should THROW on updating 2FA flag", async () => {
				await contracts.userBackend.set2FA(true, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should THROW on updating backend", async () => {
				const newBackend = "0xffffffffffffffffffffffffffffffffffffffff"
				await contracts.userBackend.updateBackendProvider(newBackend, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should be able to transfer contract ownership", async () => {
				const newOwner = users.user3
				await contracts.userBackend.transferOwnership(newOwner, { from: users.contractOwner, })
				assert.equal(await contracts.userBackend.contractOwner.call(), newOwner)

				await reverter.promisifyRevert()
			})

			it("should be able to change&claim contract ownership", async () => {
				const newOwner = users.user3
				await contracts.userBackend.changeContractOwnership(newOwner, { from: users.contractOwner, })
				assert.isTrue((await contracts.userBackend.claimContractOwnership.call({ from: newOwner, })))

				await contracts.userBackend.claimContractOwnership({ from: newOwner, })
				assert.equal(await contracts.userBackend.contractOwner.call(), newOwner)

				await reverter.promisifyRevert()
			})
		})

		describe("user registry", () => {

			after(async () => {
				await reverter.promisifyRevert()
			})

			it("should have set up events history", async () => {
				assert.notEqual(await contracts.userRegistry.getEventsHistory(), utils.zeroAddress)
			})
		})

		describe("user backend provider", () => {

			afterEach(async () => {
				await reverter.promisifyRevert()
			})

			it("should have non-null userBackend value", async () => {
				assert.notEqual(
					await contracts.userBackendProvider.getUserBackend.call(),
					utils.zeroAddress
				)
			})

			it("should protect setUserBackend by auth", async () => {
				const caller = users.user3
				const newUserBackend = "0x0000ffffffffffffffffffffffffffffffff0000"

				await contracts.userBackendProvider.setRoles2Library(contracts.mock.address)
				await contracts.mock.expect(
					contracts.userBackendProvider.address,
					0,
					contracts.rolesLibrary.contract.canCall.getData(caller, contracts.userBackendProvider.address, contracts.userBackendProvider.contract.setUserBackend.getData(0x0).slice(0, 10)),
					await contracts.mock.convertUIntToBytes32(1)
				)

				assert.equal(
					(await contracts.userBackendProvider.setUserBackend.call(newUserBackend, { from: caller, })).toNumber(),
					ErrorScope.OK
				)

				await contracts.userBackendProvider.setUserBackend(newUserBackend, { from: caller, })
				await assertExpectations()

				assert.equal(
					await contracts.userBackendProvider.getUserBackend.call(),
					newUserBackend
				)
			})

			it("should THROW and NOT allow to set 0x0 to userBackend", async () => {
				await contracts.userBackendProvider.setUserBackend(utils.zeroAddress, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should have non-null user registry value", async () => {
				assert.notEqual(
					await contracts.userBackendProvider.getUserRegistry.call(),
					utils.zeroAddress
				)
			})

			it("should protect setUserRegistry by auth", async () => {
				const caller = users.user3
				const newUserRegistry = "0x0000ffffffffffffffffffffffffffffffff0000"

				await contracts.userBackendProvider.setRoles2Library(contracts.mock.address)
				await contracts.mock.expect(
					contracts.userBackendProvider.address,
					0,
					contracts.rolesLibrary.contract.canCall.getData(caller, contracts.userBackendProvider.address, contracts.userBackendProvider.contract.setUserRegistry.getData(0x0).slice(0, 10)),
					await contracts.mock.convertUIntToBytes32(1)
				)

				assert.equal(
					(await contracts.userBackendProvider.setUserRegistry.call(newUserRegistry, { from: caller, })).toNumber(),
					ErrorScope.OK
				)

				await contracts.userBackendProvider.setUserRegistry(newUserRegistry, { from: caller, })
				await assertExpectations()

				assert.equal(
					await contracts.userBackendProvider.getUserRegistry.call(),
					newUserRegistry
				)
			})

			it("should allow to set 0x0 to user registry", async () => {
				await contracts.userBackendProvider.setUserRegistry(utils.zeroAddress, { from: users.contractOwner, })
				assert.equal(
					await contracts.userBackendProvider.getUserRegistry.call(),
					utils.zeroAddress
				)
			})
		})

	})

	context("creation", () => {
		const user = users.user1

		let userRouterAddress
		let userProxyAddress
		let snapshotId

		before(async () => {
			snapshotId = reverter.snapshotId
		})

		after(async () => {
			await reverter.promisifyRevert(snapshotId)
		})

		it("should THROW and NOT allow to set 2FA for a user without proper init (calling 'init' function)", async () => {
			const stubUser = await UserRouter.new(user, users.recovery, contracts.userBackendProvider.address, { from: users.contractOwner, })
			await UserInterface.at(stubUser.address).set2FA(true, { from: user, }).then(assert.fail, () => true)
		})

		it("should NOT allow to init a created user by a non-issuer with UNAUTHORIZED code", async () => {
			const issuer = users.user3
			const nonIssuer = users.user2
			const stubUser = await UserRouter.new(user, users.recovery, contracts.userBackendProvider.address, { from: issuer, })
			assert.equal(
				(await UserInterface.at(stubUser.address).init.call(users.oracle, true, { from: nonIssuer, })).toNumber(),
				ErrorScope.UNAUTHORIZED
			)

			await UserInterface.at(stubUser.address).init(users.oracle, true, { from: nonIssuer, })
			await UserInterface.at(stubUser.address).getOracle().then(assert.fail, () => true)
			assert.isFalse(await UserInterface.at(stubUser.address).use2FA.call())
		})

		it("should allow to create a user with manual init by issuer", async () => {
			const issuer = users.user3
			const stubUser = await UserRouter.new(user, users.recovery, contracts.userBackendProvider.address, { from: issuer, })
			assert.equal(
				(await UserInterface.at(stubUser.address).init.call(users.oracle, true, { from: issuer, })).toNumber(),
				ErrorScope.OK
			)

			await UserInterface.at(stubUser.address).init(users.oracle, true, { from: issuer, })
			assert.equal(
				await UserInterface.at(stubUser.address).getOracle.call(),
				users.oracle
			)
			assert.isTrue(await UserInterface.at(stubUser.address).use2FA.call())
		})

		it("should THROW and NOT allow to create a user without an owner", async () => {
			await contracts.userFactory.createUserWithProxyAndRecovery(utils.zeroAddress, false, { from: user, }).then(assert.fail, () => true)
		})

		it("should THROW and NOT allow to create a user without backend provider", async () => {
			await UserRouter.new(user, users.recovery, utils.zeroAddress, { from: users.contractOwner, }).then(assert.fail, () => true)
		})

		it("should THROW and NOT allow to pass 0x0 to update a user backend provider", async () => {
			const issuer = users.contractOwner
			const stubUser = await UserRouter.new(user, users.recovery, contracts.userBackendProvider.address, { from: issuer, })
			await UserInterface.at(stubUser.address).updateBackendProvider(utils.zeroAddress, { from: issuer, }).then(assert.fail, () => true)
		})

		it("should be able to create a new user", async () => {
			const tx = await contracts.userFactory.createUserWithProxyAndRecovery(user, false, { from: user, })
			{
				const event = (await eventHelpers.findEvent([contracts.userFactory,], tx, "UserCreated"))[0]
				assert.isDefined(event)
				assert.isDefined(event.args.user)
				assert.isDefined(event.args.proxy)
				assert.equal(event.args.recoveryContract, users.recovery)
				assert.equal(event.args.owner, user)

				userRouterAddress = event.args.user
				userProxyAddress = event.args.proxy
			}
			{
				const event = (await eventHelpers.findEvent([contracts.userRegistry,], tx, "UserContractAdded"))[0]
				assert.isDefined(event)
				assert.equal(event.args.userContract, userRouterAddress)
			}
		})

		it("should be able to create a new user with no set up user registry", async () => {
			await reverter.promisifySnapshot()
			const snapshotId = reverter.snapshotId

			await contracts.userBackendProvider.setUserRegistry(0x0, { from: users.contractOwner, })
			const tx = await contracts.userFactory.createUserWithProxyAndRecovery(user, false, { from: user, })
			{
				const event = (await eventHelpers.findEvent([contracts.userFactory,], tx, "UserCreated"))[0]
				assert.isDefined(event)
				assert.isDefined(event.args.user)
				assert.isDefined(event.args.proxy)
				assert.equal(event.args.recoveryContract, users.recovery)
				assert.equal(event.args.owner, user)
			}
			{
				const event = (await eventHelpers.findEvent([contracts.userRegistry,], tx, "UserContractAdded"))[0]
				assert.isUndefined(event)
			}

			await reverter.promisifyRevert(snapshotId)
		})

		it("should have correct contract owner for a user", async () => {
			assert.equal(
				user,
				await Owned.at(userRouterAddress).contractOwner.call()
			)
		})

		it("should have correct user proxy address", async () => {
			assert.equal(
				userProxyAddress,
				await UserInterface.at(userRouterAddress).getUserProxy.call()
			)
		})

		it("should have user contract be registered in UserRegistry", async () => {
			assert.include(await contracts.userRegistry.getUserContracts(user), userRouterAddress)
		})

		it("should NOT allow to initialize newly created user from UserFactory with UNAUTHORIZED code", async () => {
			assert.equal(
				(await UserInterface.at(userRouterAddress).init.call(users.oracle, false, { from: user, })).toNumber(),
				ErrorScope.UNAUTHORIZED
			)
		})

		it("user should have issuer and backend", async () => {
			assert.equal(
				(await UserRouter.at(userRouterAddress).backendProvider.call()),
				contracts.userBackendProvider.address
			)
			assert.equal(
				(await UserRouter.at(userRouterAddress).issuer.call()),
				contracts.userFactory.address
			)
		})

		it("user should have disabled 2FA by default", async () => {
			assert.equal(
				(await UserRouter.at(userRouterAddress).use2FA.call()),
				false
			)
		})

		it("user should be able to forward a call by a user", async () => {
			const data = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(user, false)
			await contracts.mock.expect(
				userProxyAddress,
				0,
				data,
				await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
			)

			await UserInterface.at(userRouterAddress).forward(contracts.mock.address, data, 0, true, { from: user, }).then(() => true, assert.fail)
			await assertExpectations()
		})

		it("anyone should NOT be able to update recovery contract with UNAUTHORIZED code", async () => {
			const newRecovery = users.user3
			assert.equal(
				(await UserInterface.at(userRouterAddress).setRecoveryContract.call(newRecovery, { from: users.user3, })).toNumber(),
				ErrorScope.UNAUTHORIZED
			)
		})

		it("should THROW when pass 0x0 for recovery contract", async () => {
			await UserInterface.at(userRouterAddress).setRecoveryContract(utils.zeroAddress, { from: user, }).then(assert.fail, () => true)
		})

		it("user should be able to update recovery contract with OK code", async () => {
			const newRecovery = users.user3
			assert.equal(
				(await UserInterface.at(userRouterAddress).setRecoveryContract.call(newRecovery, { from: user, })).toNumber(),
				ErrorScope.OK
			)
		})

		const newRecovery = users.user3

		it("user should be able to recover with OK code", async () => {
			const oldRecovery = users.recovery
			const newUser = users.user2
			await UserInterface.at(userRouterAddress).setRecoveryContract(newRecovery, { from: user, })

			assert.equal(
				(await UserInterface.at(userRouterAddress).recoverUser.call(newUser, { from: oldRecovery, })).toNumber(),
				ErrorScope.UNAUTHORIZED
			)
			assert.equal(
				(await UserInterface.at(userRouterAddress).recoverUser.call(newUser, { from: newRecovery, })).toNumber(),
				ErrorScope.OK
			)
		})

		it("should THROW when pass 0x0 for a new user during recovery", async () => {
			await UserInterface.at(userRouterAddress).recoverUser(utils.zeroAddress, { from: newRecovery, }).then(assert.fail, () => true)
		})

		it("user should be able to recover", async () => {
			await reverter.promisifySnapshot()
			const snapshotId = reverter.snapshotId

			const newUser = users.user2
			const tx = await UserInterface.at(userRouterAddress).recoverUser(newUser, { from: newRecovery, })
			assert.equal(await Owned.at(userRouterAddress).contractOwner.call(), newUser)
			assert.isTrue(await UserInterface.at(userRouterAddress).isOwner(newUser), "current contract owner should be in multisig")
			assert.isFalse(await UserInterface.at(userRouterAddress).isOwner(user), "previous contract owner should not be in multisig")
			console.log(`#### ${await contracts.userBackendProvider.getUserRegistry()}`)
			assert.notInclude(await contracts.userRegistry.getUserContracts(user), userRouterAddress)
			assert.include(await contracts.userRegistry.getUserContracts(newUser), userRouterAddress)
			{
				const event = (await eventHelpers.findEvent([contracts.userRegistry,], tx, "UserContractChanged"))[0]
				assert.isDefined(event)
				assert.equal(event.args.userContract, userRouterAddress)
				assert.equal(event.args.oldOwner, user)
				assert.equal(event.args.owner, newUser)
			}

			await reverter.promisifyRevert(snapshotId)
		})

		it("anyone should NOT be able to update an oracle with UNAUTHORIZED code", async () => {
			const newOracle = users.user3
			assert.equal(
				(await UserInterface.at(userRouterAddress).setOracle.call(newOracle, { from: users.user3, })).toNumber(),
				ErrorScope.UNAUTHORIZED
			)
		})

		it("should THROW when pass 0x0 oracle", async () => {
			await UserInterface.at(userRouterAddress).setOracle(utils.zeroAddress, { from: user, }).then(assert.fail, () => true)
		})

		it("user should be able to update an oracle with OK code", async () => {
			const newOracle = users.user3
			assert.equal(
				(await UserInterface.at(userRouterAddress).setOracle.call(newOracle, { from: user, })).toNumber(),
				ErrorScope.OK
			)
		})

		it("user should be able to update an oracle", async () => {
			const newOracle = users.user3
			await UserInterface.at(userRouterAddress).setOracle(newOracle, { from: user, })

			assert.equal(
				await UserInterface.at(userRouterAddress).getOracle.call(),
				newOracle
			)
		})

		const newUser = users.user2

		it("a new owner should not be a multisig owner", async () => {
			assert.isTrue(await UserInterface.at(userRouterAddress).isOwner(user))
			assert.isFalse(await UserInterface.at(userRouterAddress).isOwner(newUser))
		})

		it("should NOT allow to transfer a contract ownership to another user by non-contract owner", async () => {
			assert.notEqual(await Owned.at(userRouterAddress).contractOwner.call(), newUser)
			assert.isFalse(await Owned.at(userRouterAddress).transferOwnership.call(newUser, { from: newUser, }))
		})

		it("should be able to transfer a contract ownership to another user", async () => {
			assert.notEqual(await Owned.at(userRouterAddress).contractOwner.call(), newUser)

			await Owned.at(userRouterAddress).transferOwnership(newUser, { from: user, })
			assert.equal(await Owned.at(userRouterAddress).contractOwner.call(), newUser)
		})

		it("multisig owner should change with ownership transfer", async () => {
			assert.isTrue(await UserInterface.at(userRouterAddress).isOwner(newUser), "new contract owner should be in multisig")
			assert.isFalse(await UserInterface.at(userRouterAddress).isOwner(user), "old contract owner should not be in multisig")
		})

		it("should update record in user registry after ownership transfer", async () => {
			assert.notInclude(await contracts.userRegistry.getUserContracts(user), userRouterAddress)
			assert.include(await contracts.userRegistry.getUserContracts(newUser), userRouterAddress)
		})

		it("should be able to change&claim contract ownership", async () => {
			await Owned.at(userRouterAddress).changeContractOwnership(user, { from: newUser, })
			assert.isTrue(await Owned.at(userRouterAddress).claimContractOwnership.call({ from: user, }))

			await Owned.at(userRouterAddress).claimContractOwnership({ from: user, })
			assert.equal(await Owned.at(userRouterAddress).contractOwner.call(), user)
		})

		it("multisig owner should change with ownership transfer", async () => {
			assert.isTrue(await UserInterface.at(userRouterAddress).isOwner(user), "current contract owner should be in multisig")
			assert.isFalse(await UserInterface.at(userRouterAddress).isOwner(newUser), "previous contract owner should not be in multisig")
		})

		it("should update record in user registry after ownership transfer", async () => {
			assert.include(await contracts.userRegistry.getUserContracts(user), userRouterAddress)
			assert.notInclude(await contracts.userRegistry.getUserContracts(newUser), userRouterAddress)
		})

		it("user should be able to transfer ownership with no set up user registry contract", async () => {
			await reverter.promisifySnapshot()
			const snapshotId = reverter.snapshotId

			assert.equal(await Owned.at(userRouterAddress).contractOwner.call(), user)
			await contracts.userBackendProvider.setUserRegistry(0x0, { from: users.contractOwner, })
			await Owned.at(userRouterAddress).transferOwnership(newUser, { from: user, })
			assert.equal(await Owned.at(userRouterAddress).contractOwner.call(), newUser)

			await reverter.promisifyRevert(snapshotId)
		})

		it("should NOT allow to change&claim a contract ownership to another user by non-contract owner", async () => {
			assert.notEqual(await Owned.at(userRouterAddress).contractOwner.call(), newUser)
			assert.isFalse(await Owned.at(userRouterAddress).changeContractOwnership.call(newUser, { from: newUser, }))

			await Owned.at(userRouterAddress).changeContractOwnership(newUser, { from: newUser, })
			assert.isFalse(await Owned.at(userRouterAddress).claimContractOwnership.call({ from: newUser, }))
		})

		it("should allow to create a user with 'use2FA = true'", async () => {
			const tx = await contracts.userFactory.createUserWithProxyAndRecovery(user, true, { from: user, })
			{
				const event = (await eventHelpers.findEvent([contracts.userFactory,], tx, "UserCreated"))[0]
				assert.isDefined(event)
				assert.isTrue(await UserInterface.at(event.args.user).use2FA.call())
			}
		})
	})

	context("update", () => {
		const user = users.user1

		let userRouter
		let userProxy

		let snapshotId

		before(async () => {
			const tx = await contracts.userFactory.createUserWithProxyAndRecovery(user, false, { from: user, })
			{
				const event = (await eventHelpers.findEvent([contracts.userFactory,], tx, "UserCreated"))[0]
				userRouter = UserInterface.at(event.args.user)
				userProxy = UserProxy.at(event.args.proxy)
			}

			snapshotId = reverter.snapshotId
			await reverter.promisifySnapshot()
		})

		after(async () => {
			await reverter.promisifyRevert(snapshotId)
		})

		describe("proxy", () => {

			let newUserProxy

			before(async () => {
				newUserProxy = await UserProxy.new({ from: users.contractOwner, })
				await newUserProxy.transferOwnership(userRouter.address, { from: users.contractOwner, })

				assert.equal(await newUserProxy.contractOwner.call(), userRouter.address)
			})

			after(async () => {
				await reverter.promisifyRevert()
			})

			afterEach(async () => {
				await contracts.mock.skipExpectations()
			})

			it("and user router should have a proxy", async () => {
				assert.equal(await userRouter.getUserProxy(), userProxy.address)
			})

			it("where anyone should NOT allowed to update user proxy with UNAUTHORIZED code", async () => {
				assert.equal(
					(await userRouter.setUserProxy.call(newUserProxy.address, { from: users.user3, })).toNumber(),
					ErrorScope.UNAUTHORIZED
				)
			})

			it("where user should be allowed to update user proxy with OK code", async () => {
				assert.equal(
					(await userRouter.setUserProxy.call(newUserProxy.address, { from: user, })).toNumber(),
					ErrorScope.OK
				)
			})

			it("where user should be allowed to update user proxy", async () => {
				await userRouter.setUserProxy(newUserProxy.address, { from: user, })
				assert.equal(await userRouter.getUserProxy(), newUserProxy.address)
			})

			it("and forward should NOT go through old proxy", async () => {
				const data = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(user, false)
				await contracts.mock.expect(
					userProxy.address,
					0,
					data,
					await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
				)

				await userRouter.forward(contracts.mock.address, data, 0, true, { from: user, }).then(() => true, assert.fail)
				await assertExpectations(1)
			})

			it("and forward should go through a new proxy", async () => {
				const data = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(user, false)
				await contracts.mock.expect(
					newUserProxy.address,
					0,
					data,
					await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
				)

				await userRouter.forward(contracts.mock.address, data, 0, true, { from: user, }).then(() => true, assert.fail)
				await assertExpectations()
			})
		})

		describe("oracle", () => {
		})

		describe("backend", () => {
			let newUserBackend

			before(async () => {
				newUserBackend = await BumpedUserBackend.new({ from: users.contractOwner, })
			})

			after(async () => {
				await reverter.promisifyRevert()
			})

			it("and have up to date backend provider address", async () => {
				assert.equal(await UserRouter.at(userRouter.address).backendProvider.call(), contracts.userBackendProvider.address)
			})

			it("and forward function should NOT have 'BumpedUserBackendEvent' event emitted", async () => {
				const data = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(user, false)
				await contracts.mock.expect(
					userProxy.address,
					0,
					data,
					await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
				)

				const tx = await userRouter.forward(contracts.mock.address, data, 0, true, { from: user, }).then(r => r, assert.fail)
				{
					const event = (await eventHelpers.findEvent([ contracts.userBackend, userRouter, ], tx, "BumpedUserBackendEvent"))[0]
					assert.isUndefined(event)
				}
			})

			it("should THROW when pass 0x0 user backend", async () => {
				await contracts.userBackendProvider.setUserBackend(utils.zeroAddress, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("should update user backend in user backend provider", async () => {
				await contracts.userBackendProvider.setUserBackend(newUserBackend.address, { from: users.contractOwner, })
				assert.equal(
					await contracts.userBackendProvider.getUserBackend.call(),
					newUserBackend.address
				)
			})

			it("and forward function should have 'BumpedUserBackendEvent' event emitted", async () => {
				const data = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(user, false)
				await contracts.mock.expect(
					userProxy.address,
					0,
					data,
					await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
				)

				const tx = await userRouter.forward(contracts.mock.address, data, 0, true, { from: user, }).then(r => r, assert.fail)
				{
					const event = (await eventHelpers.findEvent([ newUserBackend, userRouter, ], tx, "BumpedUserBackendEvent"))[0]
					assert.isDefined(event)
				}
			})
		})

		describe("backend provider", () => {
			let newUserBackendProvider
			let snapshotId

			before(async () => {
				newUserBackendProvider = await UserBackendProvider.new(contracts.rolesLibrary.address, { from: users.contractOwner, })
				await newUserBackendProvider.setUserBackend(contracts.userBackend.address, { from: users.contractOwner, })

				snapshotId = reverter.snapshotId
				await reverter.promisifySnapshot()
			})

			after(async () => {
				await reverter.promisifyRevert(snapshotId)
			})

			it("and have up to date backend provider address", async () => {
				assert.equal(await UserRouter.at(userRouter.address).backendProvider.call(), contracts.userBackendProvider.address)
			})

			it("where anyone should NOT be able to update backend by himself with UNAUTHORIZED code", async () => {
				assert.equal(
					(await userRouter.updateBackendProvider.call(newUserBackendProvider.address, { from: users.user2, })).toNumber(),
					ErrorScope.UNAUTHORIZED
				)
			})

			it("and should protect setUserBackendProvider function with auth", async () => {
				const caller = users.user2

				await reverter.promisifySnapshot()

				await contracts.userFactory.setRoles2Library(contracts.mock.address)
				await contracts.mock.expect(
					contracts.userFactory.address,
					0,
					contracts.rolesLibrary.contract.canCall.getData(caller, contracts.userFactory.address, contracts.userFactory.contract.setUserBackendProvider.getData(0x0).slice(0, 10)),
					await contracts.mock.convertUIntToBytes32(ErrorScope.OK)
				)
				assert.equal(
					(await contracts.userFactory.setUserBackendProvider.call(newUserBackendProvider.address, { from: caller, })).toNumber(),
					ErrorScope.OK
				)

				await contracts.userFactory.setUserBackendProvider(newUserBackendProvider.address, { from: caller, })
				await assertExpectations()

				await reverter.promisifyRevert()
			})

			it("and should THROW when pass 0x0 for user backend provider", async () => {
				await contracts.userFactory.setUserBackendProvider(utils.zeroAddress, { from: users.contractOwner, }).then(assert.fail, () => true)
			})

			it("and base backend provider should be updated in user factory first", async () => {
				await contracts.userFactory.setUserBackendProvider(newUserBackendProvider.address, { from: users.contractOwner, })
				assert.equal(await contracts.userFactory.userBackendProvider.call(), newUserBackendProvider.address)
			})

			it("and should protect updateBackendProviderForUser function with auth", async () => {
				const caller = users.user2

				await reverter.promisifySnapshot()

				await contracts.userFactory.setRoles2Library(contracts.mock.address)
				await contracts.mock.expect(
					contracts.userFactory.address,
					0,
					contracts.rolesLibrary.contract.canCall.getData(caller, contracts.userFactory.address, contracts.userFactory.contract.updateBackendProviderForUser.getData(0x0).slice(0, 10)),
					await contracts.mock.convertUIntToBytes32(ErrorScope.OK)
				)
				assert.equal(
					(await contracts.userFactory.updateBackendProviderForUser.call(userRouter.address, { from: caller, })).toNumber(),
					ErrorScope.OK
				)

				await contracts.userFactory.updateBackendProviderForUser(userRouter.address, { from: caller, })
				await assertExpectations()

				await reverter.promisifyRevert()
			})

			it("where issuer should be able to update backend to the newest version", async () => {
				await contracts.userFactory.updateBackendProviderForUser(userRouter.address, { from: users.contractOwner, })
				assert.equal(await UserRouter.at(userRouter.address).backendProvider.call(), newUserBackendProvider.address)
			})
		})

		describe("2FA", () => {

			after(async () => {
				await reverter.promisifyRevert()
			})

			afterEach(async () => {
				await contracts.mock.resetCallsCount()
			})

			context("when it is disabled", () => {
				let data

				before(async () => {
					data = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(user, false)
				})

				after(async () => {
					await reverter.promisifyRevert()
				})

				it("by default should be 'false'", async () => {
					assert.isFalse(await userRouter.use2FA.call())
				})

				it("should do nothing when pass 'false' again", async () => {
					assert.equal(
						(await userRouter.set2FA.call(false, { from: user, })).toNumber(),
						ErrorScope.OK
					)
				})

				it("and should allow to call forward with 2FA = 'false' immediately", async () => {
					const data = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(user, false)
					await contracts.mock.expect(
						userProxy.address,
						0,
						data,
						await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
					)

					const tx = await userRouter.forward(contracts.mock.address, data, 0, true, { from: user, }).then(r => r, assert.fail)
					{
						const event = (await eventHelpers.findEvent([userRouter,], tx, "User2FAChanged"))[0]
						assert.isUndefined(event)
					}
					await assertNoMultisigPresence(tx)
				})

				it("and anyone should NOT be able to turn on 2FA with UNAUTHORIZED code", async () => {
					assert.equal(
						(await userRouter.set2FA.call(true, { from: users.user2, })).toNumber(),
						ErrorScope.UNAUTHORIZED
					)
				})

				it("and user should be able to turn on 2FA with OK code", async () => {
					assert.equal(
						(await userRouter.set2FA.call(true, { from: user, })).toNumber(),
						ErrorScope.OK
					)
				})

				it("and user should be able to turn on 2FA", async () => {
					const tx = await userRouter.set2FA(true, { from: user, })
					{
						const event = (await eventHelpers.findEvent([userRouter,], tx, "User2FAChanged"))[0]
						assert.isDefined(event)
						assert.equal(event.address, userRouter.address)
						assert.equal(event.name, 'User2FAChanged')
						assert.equal(event.args.self, userRouter.address)
						assert.equal(event.args.initiator, user)
						assert.equal(event.args.user, userRouter.address)
						assert.equal(event.args.proxy, await userRouter.getUserProxy())
						assert.isTrue(event.args.enabled)
					}
					assert.isTrue(await userRouter.use2FA.call())
				})

				it("and user should be able to submit forward call with MULTISIG_ADDED code", async () => {
					assert.equal(
						(await userRouter.forward.call(contracts.mock.address, data, 0, true, { from: user, })),
						await contracts.mock.convertUIntToBytes32(ErrorScope.MULTISIG_ADDED)
					)
				})

				let transactionId

				it("and user should be able to submit forward call but not execute without oracle", async () => {
					await contracts.mock.expect(
						userProxy.address,
						0,
						data,
						await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
					)

					const tx = await userRouter.forward(contracts.mock.address, data, 0, true, { from: user, }).then(r => r, assert.fail)
					await assertExpectations(1, 0)
					transactionId = await assertMultisigSubmitPresence({ tx, userProxy, user, })
				})

				it("and anyone THROW and should NOT able to confirm submitted transaction and execute forward call", async () => {
					await userRouter.confirmTransaction.call(transactionId, { from: users.user3, }).then(assert.fail, () => true)
				})

				it("and user THROW and should NOT able to confirm submitted by him transaction and execute forward call", async () => {
					await userRouter.confirmTransaction.call(transactionId, { from: user, }).then(assert.fail, () => true)
				})

				it("and oracle should confirm submitted transaction and execute forward call", async () => {
					const tx = await userRouter.confirmTransaction(transactionId, { from: users.oracle, }).then(r => r, assert.fail)
					await assertExpectations(0, 1)
					await assertMultisigExecutionPresence({
						tx, transactionId, userRouter, oracle: users.oracle,
					})
					{
						const event = (await eventHelpers.findEvent([userProxy,], tx, "Forwarded"))[0]
						assert.isDefined(event)
						assert.equal(event.args.destination, contracts.mock.address)
						assert.equal(event.args.value, 0)
						assert.equal(event.args.data, data)
					}
				})

			})

			context("when it is enabled and protecting", () => {

				let snapshotId

				before(async () => {
					await userRouter.set2FA(true, { from: user, })

					snapshotId = reverter.snapshotId
					await reverter.promisifySnapshot()
				})

				after(async () => {
					await reverter.promisifyRevert(snapshotId)
				})

				it("while 2FA is true", async () => {
					assert.isTrue(await userRouter.use2FA.call())
				})

				describe("update of recovery contract", () => {
					const newRecoveryAddress = users.user3
					let transactionId

					after(async () => {
						await reverter.promisifyRevert()
					})

					it("where current recovery is NOT equal to a new recovery address", async () => {
						assert.notEqual(await userRouter.getRecoveryContract.call(), newRecoveryAddress)
					})

					it("should allow to submit update of recovery contract by a user with MULTISIG_ADDED code", async () => {
						assert.equal(
							(await userRouter.setRecoveryContract.call(newRecoveryAddress, { from: user, })).toNumber(),
							ErrorScope.MULTISIG_ADDED
						)
					})

					it("should allow to submit update of recovery contract by an user", async () => {
						const tx = await userRouter.setRecoveryContract(newRecoveryAddress, { from: user, })
						transactionId = await assertMultisigSubmitPresence({ tx, userProxy, user, })
					})

					it("should allow to confirm update of recovery contract by an oracle", async () => {
						const tx = await userRouter.confirmTransaction(transactionId, { from: users.oracle, })
						await assertMultisigExecutionPresence({
							tx, transactionId, userRouter, oracle: users.oracle,
						})
					})

					it("should have a changed recovery address", async () => {
						assert.equal(await userRouter.getRecoveryContract.call(), newRecoveryAddress)
					})
				})

				describe("not guarded by multisig a user recovery function", () => {
					const newUserOwner = users.user3

					after(async () => {
						await reverter.promisifyRevert()
					})

					it("should have valid contract owner", async () => {
						assert.equal(await Owned.at(userRouter.address).contractOwner.call(), user)
					})

					it("should NOT have multisig when trying to recover a user with OK code", async () => {
						assert.equal(
							(await userRouter.recoverUser.call(newUserOwner, { from: users.recovery, })).toNumber(),
							ErrorScope.OK
						)
					})

					it("should NOT have multisig when trying to recover a user", async () => {
						const tx = await userRouter.recoverUser(newUserOwner, { from: users.recovery, })
						await assertNoMultisigPresence(tx)
					})

					it("should have updated contract owner", async () => {
						assert.equal(await Owned.at(userRouter.address).contractOwner.call(), newUserOwner)
					})

					it("should have updated multisig owners", async () => {
						assert.isTrue(await userRouter.isOwner(newUserOwner))
						assert.isFalse(await userRouter.isOwner(user))
					})
				})

				describe("change contract ownership", () => {
					const newUserOwner = users.user3

					context("with transferOwnership", () => {
						after(async () => {
							await reverter.promisifyRevert()
						})

						it("should have valid contract owner", async () => {
							assert.equal(await Owned.at(userRouter.address).contractOwner.call(), user)
						})

						it("should THROW NOT allow to submit transfer of contract ownership by a contract owner", async () => {
							await Owned.at(userRouter.address).transferOwnership(newUserOwner, { from: user, }).then(assert.fail, () => true)
						})

						it("should NOT update multisig owners", async () => {
							assert.isFalse(await userRouter.isOwner(newUserOwner))
							assert.isTrue(await userRouter.isOwner(user))
						})
					})

					context("with change&claim", () => {
						after(async () => {
							await reverter.promisifyRevert()
						})

						it("should have valid contract owner", async () => {
							assert.equal(await Owned.at(userRouter.address).contractOwner.call(), user)
						})

						it("should THROW and NOT allow to submit transfer of contract ownership by a contract owner", async () => {
							await Owned.at(userRouter.address).changeContractOwnership(newUserOwner, { from: user, }).then(assert.fail, () => true)
						})

						it("should NOT update multisig owners", async () => {
							assert.isFalse(await userRouter.isOwner(newUserOwner))
							assert.isTrue(await userRouter.isOwner(user))
						})
					})
				})

				describe("update of user proxy", () => {
					const newUserProxyAddress = "0xffffffffffffffffffffffffffffffffffffffff"
					let transactionId

					after(async () => {
						await reverter.promisifyRevert()
					})

					it("where current user proxy is NOT equal to a new user proxy address", async () => {
						assert.notEqual(await userRouter.getUserProxy.call(), newUserProxyAddress)
					})

					it("should allow to submit update of user proxy by a user with MULTISIG_ADDED code", async () => {
						assert.equal(
							(await userRouter.setUserProxy.call(newUserProxyAddress, { from: user, })).toNumber(),
							ErrorScope.MULTISIG_ADDED
						)
					})

					it("should allow to submit update of user proxy by a user", async () => {
						const tx = await userRouter.setUserProxy(newUserProxyAddress, { from: user, })
						transactionId = await assertMultisigSubmitPresence({ tx, userProxy, user, })
					})

					it("should allow to confirm update of user proxy contract by an oracle", async () => {
						const tx = await userRouter.confirmTransaction(transactionId, { from: users.oracle, })
						await assertMultisigExecutionPresence({
							tx, transactionId, userRouter, oracle: users.oracle,
						})
					})

					it("should have a changed user proxy address", async () => {
						assert.equal(await userRouter.getUserProxy.call(), newUserProxyAddress)
					})
				})

				describe("update of oracle", () => {
					const newOracleAddress = users.user2
					var transactionId

					after(async () => {
						await reverter.promisifyRevert()
					})

					it("where current oracle is NOT equal to a new oracle address", async () => {
						assert.notEqual(await userRouter.getOracle.call(), newOracleAddress)
					})

					it("should allow to submit update of oracle by a user with MULTISIG_ADDED code", async () => {
						assert.equal(
							(await userRouter.setOracle.call(newOracleAddress, { from: user, })).toNumber(),
							ErrorScope.MULTISIG_ADDED
						)
					})

					it("should allow to submit update of oracle by a user", async () => {
						const tx = await userRouter.setOracle(newOracleAddress, { from: user, })
						transactionId = await assertMultisigSubmitPresence({ tx, userProxy, user, })
					})

					it("should allow to confirm update of oracle by an oracle", async () => {
						const tx = await userRouter.confirmTransaction(transactionId, { from: users.oracle, })
						await assertMultisigExecutionPresence({
							tx, transactionId, userRouter, oracle: users.oracle,
						})
					})

					it("should have a changed oracle address", async () => {
						assert.equal(await userRouter.getOracle.call(), newOracleAddress)
					})

					it("should be able to perform to submit new oracle change by a user to an old oracle with MULTISIG_ADDED code", async () => {
						assert.equal(
							(await userRouter.setOracle.call(users.oracle, { from: user, })).toNumber(),
							ErrorScope.MULTISIG_ADDED
						)
					})

					it("should be able to perform to submit new oracle change by a user to an old oracle", async () => {
						const tx = await userRouter.setOracle(users.oracle, { from: user, })
						transactionId = await assertMultisigSubmitPresence({ tx, userProxy, user, })
					})

					it("should THROW and NOT allow to confirm update of oracle by an old oracle", async () => {
						await userRouter.confirmTransaction(transactionId, { from: users.oracle, }).then(assert.fail, () => true)
					})

					it("should allow to confirm update of oracle by a new oracle", async () => {
						const tx = await userRouter.confirmTransaction(transactionId, { from: newOracleAddress, })
						await assertMultisigExecutionPresence({
							tx, transactionId, userRouter, oracle: newOracleAddress,
						})
					})

					it("should have an old oracle address back", async () => {
						assert.equal(await userRouter.getOracle.call(), users.oracle)
					})
				})

				describe("update of use2FA from 'true' to 'false'", () => {
					let transactionId

					after(async () => {
						await reverter.promisifyRevert()
					})

					it("when initial use2FA is 'true'", async () => {
						assert.isTrue(await userRouter.use2FA.call())
					})

					it("should allow to submit update of 2FA by a user with MULTISIG_ADDED code", async () => {
						assert.equal(
							(await userRouter.set2FA.call(false, { from: user, })).toNumber(),
							ErrorScope.MULTISIG_ADDED
						)
					})

					it("should allow to submit update of 2FA by a user", async () => {
						const tx = await userRouter.set2FA(false, { from: user, })
						transactionId = await assertMultisigSubmitPresence({ tx, userProxy, user, })
						{
							const event = (await eventHelpers.findEvent([userRouter,], tx, "User2FAChanged"))[0]
							assert.isUndefined(event)
						}
					})

					it("should allow to confirm update of 2FA contract by an oracle", async () => {
						const tx = await userRouter.confirmTransaction(transactionId, { from: users.oracle, })
						await assertMultisigExecutionPresence({
							tx, transactionId, userRouter, oracle: users.oracle,
						})
						{
							const event = (await eventHelpers.findEvent([userRouter,], tx, "User2FAChanged"))[0]
							assert.isDefined(event)
							assert.equal(event.address, userRouter.address)
							assert.equal(event.name, 'User2FAChanged')
							assert.equal(event.args.self, userRouter.address)
							assert.equal(event.args.initiator, user)
							assert.equal(event.args.user, userRouter.address)
							assert.equal(event.args.proxy, userProxy.address)
							assert.isFalse(event.args.enabled)
						}
					})

					it("should have a changed 2FA address", async () => {
						assert.isFalse(await userRouter.use2FA.call())
					})
				})
			})

		})

		describe("2FA with signed data", () => {
			const pass = "0x1234"
			let message
			let signatureDetails
			let data

			before(async () => {
				data = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(user, false)
			})

			after(async () => {
				await reverter.promisifyRevert()
			})

			describe("for forwardWithVRS", () => {

				describe("with disabled 2FA", () => {

					it("should have use2FA = false", async () => {
						assert.isFalse(await userRouter.use2FA())
					})

					it("should allow to forward invocation without submitting tx", async () => {
						await contracts.mock.expect(
							userProxy.address,
							0,
							data,
							await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
						)

						const tx = await userRouter.forwardWithVRS(
							contracts.mock.address,
							data,
							0,
							true,
							pass,
							0,
							"",
							"",
							{ from: user, }
						)
						await assertExpectations()
						await assertNoMultisigPresence(tx)
					})
				})

				describe("with enabled 2FA", () => {

					before(async () => {
						await userRouter.set2FA(true, { from: user, })
					})

					it("should have use2FA = true", async () => {
						assert.isTrue(await userRouter.use2FA())
					})

					it("should NOT allow to forward invocation without proper v,r,s", async () => {
						await contracts.mock.expect(
							userProxy.address,
							0,
							data,
							await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
						)

						const tx = await userRouter.forwardWithVRS(
							contracts.mock.address,
							data,
							0,
							true,
							pass,
							0,
							"",
							"",
							{ from: user, }
						)
						await assertExpectations(1, 1)
						await assertNoMultisigPresence(tx)
						await contracts.mock.skipExpectations()
					})

					describe("signed by invalid oracle", () => {
						const notOracle = users.user2

						before(async () => {
							message = getMessageFrom({
								pass, sender: user, destination: contracts.mock.address, data, value: 0,
							})
							signatureDetails = signMessage({ message, oracle: notOracle, })
						})

						it("should NOT allow to forward invocation", async () => {
							await contracts.mock.expect(
								userProxy.address,
								0,
								data,
								await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
							)

							const tx = await userRouter.forwardWithVRS(
								contracts.mock.address,
								data,
								0,
								true,
								pass,
								signatureDetails.v,
								signatureDetails.r,
								signatureDetails.s,
								{ from: user, }
							)
							await assertExpectations(1, 1)
							await assertNoMultisigPresence(tx)
							await contracts.mock.skipExpectations()
						})
					})

					describe("signed with invalid sender", () => {
						const notUser = users.user2

						before(async () => {
							message = getMessageFrom({
								pass, sender: user, destination: contracts.mock.address, data, value: 0,
							})
							signatureDetails = signMessage({ message, oracle: users.oracle, })
						})

						it("should NOT allow to forward invocation", async () => {
							await contracts.mock.expect(
								userProxy.address,
								0,
								data,
								await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
							)

							const tx = await userRouter.forwardWithVRS(
								contracts.mock.address,
								data,
								0,
								true,
								pass,
								signatureDetails.v,
								signatureDetails.r,
								signatureDetails.s,
								{ from: notUser, }
							)
							await assertExpectations(1, 1)
							await assertNoMultisigPresence(tx)
							await contracts.mock.skipExpectations()
						})
					})

					describe("signed correctly with invalid data", () => {
						let invalidSendData

						before(async () => {
							invalidSendData = contracts.userFactory.contract.createUserWithProxyAndRecovery.getData(users.user2, true)
							message = getMessageFrom({
								pass, sender: user, destination: contracts.mock.address, data, value: 0,
							})
							signatureDetails = signMessage({ message, oracle: users.oracle, })
						})

						it("should NOT allow to forward invocation", async () => {
							await contracts.mock.expect(
								userProxy.address,
								0,
								data,
								await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
							)

							const tx = await userRouter.forwardWithVRS(
								contracts.mock.address,
								invalidSendData,
								0,
								true,
								pass,
								signatureDetails.v,
								signatureDetails.r,
								signatureDetails.s,
								{ from: user, }
							)
							await assertExpectations(1, 1)
							await assertNoMultisigPresence(tx)
							await contracts.mock.skipExpectations()
						})
					})

					describe("signed correctly with invalid pass", () => {
						const invalidPass = "0xffffffff"

						before(async () => {
							message = getMessageFrom({
								pass, sender: user, destination: contracts.mock.address, data, value: 0,
							})
							signatureDetails = signMessage({ message, oracle: users.oracle, })
						})

						it("should NOT allow to forward invocation", async () => {
							await contracts.mock.expect(
								userProxy.address,
								0,
								data,
								await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
							)

							const tx = await userRouter.forwardWithVRS(
								contracts.mock.address,
								data,
								0,
								true,
								invalidPass,
								signatureDetails.v,
								signatureDetails.r,
								signatureDetails.s,
								{ from: user, }
							)
							await assertExpectations(1, 1)
							await assertNoMultisigPresence(tx)
							await contracts.mock.skipExpectations()
						})
					})

					describe("signed correctly", () => {

						before(async () => {
							message = getMessageFrom({
								pass, sender: user, destination: contracts.mock.address, data, value: 0,
							})
							signatureDetails = signMessage({ message, oracle: users.oracle, })
						})

						it("should allow to forward invocation", async () => {
							await contracts.mock.expect(
								userProxy.address,
								0,
								data,
								await contracts.mock.convertUIntToBytes32.call(ErrorScope.OK)
							)

							const tx = await userRouter.forwardWithVRS(
								contracts.mock.address,
								data,
								0,
								true,
								pass,
								signatureDetails.v,
								signatureDetails.r,
								signatureDetails.s,
								{ from: user, }
							)
							await assertExpectations(0, 2)
							await assertNoMultisigPresence(tx)
						})
					})
				})
			})
		})
	})
})
