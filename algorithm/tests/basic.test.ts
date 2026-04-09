import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import { Result } from "better-result";
import { MessageKind } from "../src/types.js";

/** Build a minimal config used across tests to keep timing small and deterministic. */
function createTestConfig(): Required<HotStuffConfig> {
	return {
		numNodes: 3,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 100,
		maxBatchSize: 10,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
	};
}

/** Helper to create a node with a fresh in-memory store. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

// Ran in `BasicHotStuffNode::run` on init, but some tests dont want to run the full process
/** Manually seed leader-only state so tests can bypass the run loop. */
function setLeaderState(node: BasicHotStuffNode) {
	node.leaderState = {
		...node.replicaState,
		pendingVotes: new Map(),
		collectedNewViews: [],
	};
}

describe("Basic HotStuff Algorithm", () => {
	/**
	 * Verifies deterministic leader election at view 0.
	 * All nodes should compute the same leader id from the shared view number.
	 */
	it("elects a single leader at genesis", async () => {
		// Arrange
		const config = createTestConfig();
		const nodes = [createTestNode(0, config), createTestNode(1, config), createTestNode(2, config)];

		// Assert
		expect(nodes.map((node) => node.findLeader(nodes).id)).toEqual([0, 0, 0]);
	});

	/**
	 * Ensures followers forward client operations to the current leader during their step.
	 */
	// Client sends requests to all replicas, so it is not necessary to test a replica sending requests to the leader.
	// You may verify this by ctrl+f "A client sends a command request to all replicas" in the pdf: "HotStuff: BFT Consensus in the Lens of Blockchain"
	it("write requests are forwarded to the leader", async () => {
		// Arrange
		const config = createTestConfig();
		const nodes = [createTestNode(0, config), createTestNode(1, config), createTestNode(2, config)];

		// Act
		await nodes[1]!.put("key1", "value1");
		await nodes[2]!.put("key2", "value2");
		await nodes[1]!.delete("key3");
		await nodes[2]!.delete("key4");

		await nodes[1]!.step(nodes);
		await nodes[2]!.step(nodes);

		// Assert
		expect(nodes[0]!.pendingWrites.size).toBe(4);
		expect(nodes[0]!.pendingWrites.get("key1")).toBe("value1");
		expect(nodes[0]!.pendingWrites.get("key2")).toBe("value2");
		expect(nodes[0]!.pendingWrites.get("key3")).toBeNull();
		expect(nodes[0]!.pendingWrites.get("key4")).toBeNull();
	});

	/**
	 * Confirms reads are served directly from local storage and do not require consensus flow.
	 */
	it("read requests are served locally", async () => {
		// Arrange
		const config = createTestConfig();
		const node = createTestNode(0, config);
		await node.dataStore.put("key1", "value1");

		// Act
		const value = await node.read("key1");

		// Assert
		expect(value).toBe("value1");
	});

	/**
	 * Validates graceful shutdown behavior.
	 * First abort succeeds and unblocks `run`; repeated abort requests return an error result.
	 */
	it("abort resolves running nodes", async () => {
		// Arrange
		const config = {
			...createTestConfig(),
			numNodes: 1,
		};

		const node = createTestNode(0, config);
		const runPromise = node.run([node]);

		// Act
		const [abortResult, _] = await Promise.all([node.abort(), runPromise]);
		const secondAbortResult = await node.abort();

		// Assert
		expect(abortResult.isOk()).toBe(true);
		expect(secondAbortResult.isErr()).toBe(true);
		await expect(runPromise).resolves.toEqual(Result.ok());
	});

	/**
	 * Validates pause/resume semantics of the run loop.
	 * Node pauses once, rejects duplicate pause requests, then resumes when controller resolves.
	 */
	it("pause stops running nodes until resumed", async () => {
		// Arrange
		const config = {
			...createTestConfig(),
			numNodes: 1,
			loopTimeoutMaxMs: 10,
		};

		const node = createTestNode(0, config);
		const runPromise = node.run([node]);

		// Act
		let resolveFunc!: () => void;
		const pauseController = {
			promise: new Promise<void>((res) => {
				resolveFunc = res;
			}),
			resolve: () => resolveFunc(),
		};

		const pauseResult = node.pause(pauseController.promise);
		const secondPauseResult = node.pause(pauseController.promise);

		// Assert
		await expect(pauseResult).resolves.toSatisfy((result) => result.isOk());
		await expect(secondPauseResult).resolves.toSatisfy((result) => result.isErr());

		pauseController.resolve();
		await expect(node.abort()).resolves.toSatisfy((result) => result.isOk());
		await expect(runPromise).resolves.toSatisfy((result) => result.isOk());
	});

	/**
	 * Checks the leader proposal trigger path.
	 * Once follower writes are forwarded and batching threshold is met, leader emits PREPARE messages.
	 */
	it("leader sends proposals when there are pending writes", async () => {
		// Arrange
		const config = {
			...createTestConfig(),
			maxBatchSize: 1,
		};

		const [n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		setLeaderState(n1);

		await n1.put("key0", "value0");
		await n2.put("key1", "value1");
		await n3.put("key2", "value2");

		// Act
		await n3.step([n1, n2, n3]); // sends message to leader
		await n2.step([n1, n2, n3]); // sends message to leader
		await n1.step([n1, n2, n3]); // leader processes messages and sends proposal

		// Assert
		expect(n1.isLeader([n1, n2, n3])).toBe(true);
		expect(n1.messageQueue.length).toBe(0);

		expect(n2.messageQueue.length).toBe(1);
		const n2Message = n2.messageQueue[0]!;
		expect(n2Message.type).toBe(MessageKind.Prepare);
		expect(n2Message.viewNumber).toBe(0);
		expect(n2Message.senderId).toBe(n1.id);

		expect(n3.messageQueue.length).toBe(1);
		const n3Message = n3.messageQueue[0]!;
		expect(n3Message.type).toBe(MessageKind.Prepare);
		expect(n3Message.viewNumber).toBe(0);
		expect(n3Message.senderId).toBe(n1.id);
	});
});
