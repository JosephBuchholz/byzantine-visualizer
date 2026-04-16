import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../../src/index.js";
import BasicHotStuffNode from "../../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../../src/data/store.js";
import { MessageKind, type PrepareMessage, type QuorumCertificate } from "../../src/types.js";

/** Build a deterministic test config so ancestry behavior is isolated from timing noise. */
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

/** Helper to create a node with fresh in-memory state for each scenario. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Build deterministic QC fixtures used by PREPARE safety checks. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff ancestry safety semantics", () => {
	/**
	 * Ensures the safety rule uses full descendant ancestry, not just one-hop parent equality.
	 * How: lock a replica on an ancestor block, provide a proposal that is a grandchild of that
	 * lock with non-newer justify, and verify the replica still accepts and votes PREPARE.
	 * This guards against regressions in multi-hop descendant checking.
	 */
	it("accepts PREPARE when node is a multi-hop descendant of lockedQC", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		const lockedAncestorHash = "locked-ancestor";
		const middleHash = "middle-node";
		const candidateHash = "candidate-node";

		follower.replicaState.lockedQC = createQC(lockedAncestorHash, 10, MessageKind.PreCommit);

		// Seed the local block tree so descendant checks can traverse ancestor links.
		follower.knownBlocksByHash.set(lockedAncestorHash, {
			hash: lockedAncestorHash,
			parentHash: "GENESIS",
			data: { writes: [] },
			height: 1,
		});
		follower.knownBlocksByHash.set(middleHash, {
			hash: middleHash,
			parentHash: lockedAncestorHash,
			data: { writes: [] },
			height: 2,
		});

		const prepareMessage: PrepareMessage = {
			type: MessageKind.Prepare,
			// Use a view where node 0 is deterministic leader in n=3.
			viewNumber: 9,
			senderId: leader.id,
			node: {
				block: {
					hash: candidateHash,
					parentHash: middleHash,
					data: { writes: [] },
					height: 3,
				},
				parentHash: middleHash,
				justify: createQC(middleHash, 9, MessageKind.Prepare),
			},
		};

		follower.message(prepareMessage);

		// Act
		await follower.step([leader, follower, other]);

		// Assert
		expect(leader.messageQueue.length).toBe(1);
		const vote = leader.messageQueue[0]!;
		expect(vote.type).toBe(MessageKind.Vote);
		if (vote.type === MessageKind.Vote) {
			expect(vote.voteType).toBe(MessageKind.Prepare);
			expect(vote.nodeHash).toBe(candidateHash);
			expect(vote.senderId).toBe(follower.id);
		}
	});

	/**
	 * Ensures descendants that do not lie on the locked branch are rejected when liveness does not apply.
	 * How: set a lock on branch A, propose on branch B with justify view not newer than lock,
	 * and verify no PREPARE vote is emitted.
	 */
	it("rejects PREPARE on conflicting branch when justify is not newer than lock", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		follower.replicaState.lockedQC = createQC("locked-A", 12, MessageKind.PreCommit);
		follower.knownBlocksByHash.set("locked-A", {
			hash: "locked-A",
			parentHash: "GENESIS",
			data: { writes: [] },
			height: 1,
		});
		follower.knownBlocksByHash.set("fork-B", {
			hash: "fork-B",
			parentHash: "GENESIS",
			data: { writes: [] },
			height: 1,
		});

		const conflictingPrepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 12,
			senderId: leader.id,
			node: {
				block: {
					hash: "fork-B-child",
					parentHash: "fork-B",
					data: { writes: [] },
					height: 2,
				},
				parentHash: "fork-B",
				justify: createQC("fork-B", 12, MessageKind.Prepare),
			},
		};

		follower.message(conflictingPrepare);

		// Act
		await follower.step([leader, follower, other]);

		// Assert
		expect(leader.messageQueue.length).toBe(0);
	});

	/**
	 * Preserves the liveness override in safeNode for stale locks.
	 * How: propose from a different branch but with justify view higher than lock view,
	 * and verify the replica accepts and votes even when locked branch ancestry does not match.
	 */
	it("accepts PREPARE on different branch when justify view is newer than lock", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		follower.replicaState.lockedQC = createQC("locked-A", 4, MessageKind.PreCommit);

		const higherJustifyPrepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 9,
			senderId: leader.id,
			node: {
				block: {
					hash: "branch-B-child",
					parentHash: "branch-B",
					data: { writes: [] },
					height: 2,
				},
				parentHash: "branch-B",
				justify: createQC("branch-B", 9, MessageKind.Prepare),
			},
		};

		follower.message(higherJustifyPrepare);

		// Act
		await follower.step([leader, follower, other]);

		// Assert
		expect(leader.messageQueue.length).toBe(1);
		const vote = leader.messageQueue[0]!;
		expect(vote.type).toBe(MessageKind.Vote);
		if (vote.type === MessageKind.Vote) {
			expect(vote.voteType).toBe(MessageKind.Prepare);
			expect(vote.nodeHash).toBe("branch-B-child");
		}
	});

	/**
	 * Prevents false-positive descendant checks when ancestry evidence is missing.
	 * How: lock on an ancestor and propose a deeper node but do not provide intermediary ancestry
	 * in the local block tree; implementation should reject because descendant relation cannot be proven.
	 */
	it("rejects PREPARE when descendant chain to lockedQC cannot be proven from local tree", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		follower.replicaState.lockedQC = createQC("locked-ancestor", 7, MessageKind.PreCommit);
		follower.knownBlocksByHash.set("locked-ancestor", {
			hash: "locked-ancestor",
			parentHash: "GENESIS",
			data: { writes: [] },
			height: 1,
		});

		const uncertainPrepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 7,
			senderId: leader.id,
			node: {
				block: {
					hash: "candidate-with-missing-link",
					parentHash: "unknown-middle",
					data: { writes: [] },
					height: 3,
				},
				parentHash: "unknown-middle",
				justify: createQC("unknown-middle", 7, MessageKind.Prepare),
			},
		};

		follower.message(uncertainPrepare);

		// Act
		await follower.step([leader, follower, other]);

		// Assert
		expect(leader.messageQueue.length).toBe(0);
	});
});
