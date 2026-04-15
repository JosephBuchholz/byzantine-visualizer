import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import { MessageKind, type PrepareMessage, type QuorumCertificate } from "../src/types.js";

/**
 * Build a deterministic config so proposal creation is easy to trigger in one step.
 */
function createTestConfig(): Required<HotStuffConfig> {
	return {
		numNodes: 3,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 100,
		maxBatchSize: 1,
		maxBatchWaitTimeMs: 10_000,
		logger: () => {},
	};
}

/**
 * Helper to create a node with isolated in-memory state.
 */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/**
 * Build deterministic QC fixtures used to seed prepare/locked parent references.
 */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

/**
 * Extract the PREPARE proposal that a leader broadcast to a specific follower.
 */
function getPrepareFromFollowerQueue(node: BasicHotStuffNode): PrepareMessage {
	expect(node.messageQueue.length).toBe(1);
	const message = node.messageQueue[0]!;
	expect(message.type).toBe(MessageKind.Prepare);
	if (message.type !== MessageKind.Prepare) {
		throw new Error("Expected PREPARE message in follower queue");
	}

	return message;
}

describe("Basic HotStuff proposal height semantics (TDD)", () => {
	/**
	 * What: verifies proposal height comes from the parent chain, not from committed count.
	 * How: seed prepareQC to point at a parent block with explicit height 7 while committed
	 * history stays empty, then propose once and assert new block height is parentHeight + 1 (=8).
	 *
	 * This is a red test for the current bug where proposal height is derived from
	 * committedBlocks.length + 1.
	 */
	it("uses parent height when proposing from prepareQC ancestry", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, followerA, followerB] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, followerA, followerB] as const;

		const parentHash = "parent-from-prepare";
		leader.replicaState.prepareQC = createQC(parentHash, 4, MessageKind.Prepare);
		leader.knownBlocksByHash.set(parentHash, {
			hash: parentHash,
			parentHash: "GENESIS",
			data: { writes: [] },
			height: 7,
		});

		void leader.put("k", "v");

		// Act
		await leader.step(nodes);

		// Assert
		const prepare = getPrepareFromFollowerQueue(followerA);
		expect(prepare.node.parentHash).toBe(parentHash);
		expect(prepare.node.block.height).toBe(8);
	});

	/**
	 * What: verifies fallback parent selection from lockedQC also uses parent chain height.
	 * How: leave prepareQC empty, seed lockedQC to a known parent with height 3, then propose
	 * and assert emitted block height is 4.
	 *
	 * This protects the lockedQC fallback path from the same committed-count bug.
	 */
	it("uses parent height when proposing from lockedQC fallback", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, followerA, followerB] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, followerA, followerB] as const;

		const parentHash = "parent-from-lock";
		leader.replicaState.lockedQC = createQC(parentHash, 2, MessageKind.PreCommit);
		leader.knownBlocksByHash.set(parentHash, {
			hash: parentHash,
			parentHash: "GENESIS",
			data: { writes: [] },
			height: 3,
		});

		void leader.put("k2", "v2");

		// Act
		await leader.step(nodes);

		// Assert
		const prepare = getPrepareFromFollowerQueue(followerA);
		expect(prepare.node.parentHash).toBe(parentHash);
		expect(prepare.node.block.height).toBe(4);
	});

	/**
	 * What: verifies proposal height is independent from committed history size.
	 * How: prefill committedBlocks with unrelated entries (length 5), but propose from a
	 * parent block of height 2; expected height is still 3, not 6.
	 *
	 * This catches regressions where UI geometry silently depends on commit count.
	 */
	it("does not derive proposal height from committedBlocks length", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, followerA, followerB] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, followerA, followerB] as const;

		leader.replicaState.committedBlocks = [
			{ hash: "c1", parentHash: "GENESIS", data: {}, height: 1 },
			{ hash: "c2", parentHash: "c1", data: {}, height: 2 },
			{ hash: "c3", parentHash: "c2", data: {}, height: 3 },
			{ hash: "c4", parentHash: "c3", data: {}, height: 4 },
			{ hash: "c5", parentHash: "c4", data: {}, height: 5 },
		];

		const parentHash = "branch-parent";
		leader.replicaState.prepareQC = createQC(parentHash, 9, MessageKind.Prepare);
		leader.knownBlocksByHash.set(parentHash, {
			hash: parentHash,
			parentHash: "GENESIS",
			data: { writes: [] },
			height: 2,
		});

		void leader.put("k3", "v3");

		// Act
		await leader.step(nodes);

		// Assert
		const prepare = getPrepareFromFollowerQueue(followerA);
		expect(prepare.node.parentHash).toBe(parentHash);
		expect(prepare.node.block.height).toBe(3);
	});

	/**
	 * What: verifies genesis proposal remains height 1 when no parent QC exists.
	 * How: with empty prepareQC/lockedQC and one queued write, trigger a proposal and assert
	 * parent is GENESIS and height is exactly 1.
	 *
	 * This test documents the intended baseline behavior and should remain green.
	 */
	it("keeps genesis proposal at height 1", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, followerA, followerB] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, followerA, followerB] as const;

		void leader.put("k4", "v4");

		// Act
		await leader.step(nodes);

		// Assert
		const prepare = getPrepareFromFollowerQueue(followerA);
		expect(prepare.node.parentHash).toBe("GENESIS");
		expect(prepare.node.block.height).toBe(1);
	});
});
