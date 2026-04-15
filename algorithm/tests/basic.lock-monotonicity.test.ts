import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import {
	MessageKind,
	type CommitMessage,
	type QuorumCertificate,
	type VoteMessage,
} from "../src/types.js";

/** Build deterministic config for lock-monotonicity TDD scenarios. */
function createTestConfig(numNodes = 4): Required<HotStuffConfig> {
	return {
		numNodes,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 100,
		maxBatchSize: 10,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
	};
}

/** Helper to create isolated nodes with fresh in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Build deterministic QC fixtures used by COMMIT message setup. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

/** Collect COMMIT votes currently queued at a leader. */
function collectCommitVotes(node: BasicHotStuffNode): VoteMessage[] {
	return node.messageQueue.filter(
		(message): message is VoteMessage =>
			message.type === MessageKind.Vote && message.voteType === MessageKind.Commit,
	);
}

describe("Basic HotStuff lock monotonicity", () => {
	/**
	 * Verifies lock monotonicity rejects COMMIT carrying a precommitQC at the same lock view.
	 * How: seed follower with lockedQC at view v, then deliver a leader-valid COMMIT whose justify
	 * is also at view v but for a different node; lock should remain unchanged and no vote emitted.
	 */
	it("rejects COMMIT when incoming lock view equals current lockedQC view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [leaderForV8, n1, follower, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [leaderForV8, n1, follower, n3] as const;

		follower.replicaState.viewNumber = 8;
		const existingLock = createQC("locked-view-8", 8, MessageKind.PreCommit);
		follower.replicaState.lockedQC = existingLock;

		const equalViewCommit: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 8,
			senderId: leaderForV8.id,
			nodeHash: "candidate-view-8",
			justify: createQC("candidate-view-8", 8, MessageKind.PreCommit),
		};

		follower.message(equalViewCommit);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.lockedQC).toEqual(existingLock);
		expect(follower.replicaState.viewNumber).toBe(8);
		expect(collectCommitVotes(leaderForV8)).toHaveLength(0);
	});

	/**
	 * Verifies lock monotonicity rejects COMMIT carrying a lower lock view even in a newer message view.
	 * How: keep follower locked at view 8, send a leader-valid COMMIT for view 9 whose justify is
	 * only view 7; follower may advance local view tracking but must not downgrade lock or emit vote.
	 */
	it("rejects COMMIT when incoming lock view is lower than current lockedQC view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, leaderForV9, follower, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, leaderForV9, follower, n3] as const;

		follower.replicaState.viewNumber = 8;
		const existingLock = createQC("locked-view-8", 8, MessageKind.PreCommit);
		follower.replicaState.lockedQC = existingLock;

		const lowerViewCommit: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 9,
			senderId: leaderForV9.id,
			nodeHash: "candidate-view-7",
			justify: createQC("candidate-view-7", 7, MessageKind.PreCommit),
		};

		follower.message(lowerViewCommit);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.lockedQC).toEqual(existingLock);
		expect(follower.replicaState.viewNumber).toBe(8);
		expect(collectCommitVotes(leaderForV9)).toHaveLength(0);
	});

	/**
	 * Verifies lock monotonicity still allows valid forward progress.
	 * How: seed follower with lock at view 8, then deliver a leader-valid COMMIT whose justify is
	 * view 9; follower should update lock to the newer QC and emit one COMMIT vote.
	 */
	it("accepts COMMIT when incoming lock view is strictly higher than current lockedQC view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, leaderForV9, follower, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, leaderForV9, follower, n3] as const;

		follower.replicaState.viewNumber = 8;
		const existingLock = createQC("locked-view-8", 8, MessageKind.PreCommit);
		follower.replicaState.lockedQC = existingLock;

		const higherViewQC = createQC("candidate-view-9", 9, MessageKind.PreCommit);
		const higherViewCommit: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 9,
			senderId: leaderForV9.id,
			nodeHash: "candidate-view-9",
			justify: higherViewQC,
		};

		follower.message(higherViewCommit);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.lockedQC).toEqual(higherViewQC);
		expect(follower.replicaState.viewNumber).toBe(9);
		const commitVotes = collectCommitVotes(leaderForV9);
		expect(commitVotes).toHaveLength(1);
		expect(commitVotes[0]!.nodeHash).toBe("candidate-view-9");
		expect(commitVotes[0]!.senderId).toBe(follower.id);
	});
});