import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import {
	MessageKind,
	type CommitMessage,
	type PreCommitMessage,
	type QuorumCertificate,
	type VoteMessage,
} from "../src/types.js";

/** Build deterministic config for per-phase vote-memory TDD scenarios. */
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

/** Helper to create isolated test nodes with fresh in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Build deterministic QC fixtures used by PRE-COMMIT and COMMIT message setup. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

/** Collect votes of one phase currently queued at a target leader. */
function collectVotes(node: BasicHotStuffNode, voteType: MessageKind): VoteMessage[] {
	return node.messageQueue.filter(
		(message): message is VoteMessage =>
			message.type === MessageKind.Vote && message.voteType === voteType,
	);
}

describe("Basic HotStuff per-phase vote memory", () => {
	/**
	 * Verifies PRE-COMMIT vote memory enforces at most one vote per view.
	 * How: deliver two valid PRE-COMMIT messages in the same view for different node hashes from the
	 * correct leader; follower should emit only one PRE-COMMIT vote for that view.
	 */
	it("replica emits at most one PRE-COMMIT vote for conflicting messages in the same view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [follower, n1, leaderForV2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [follower, n1, leaderForV2, n3] as const;

		follower.replicaState.viewNumber = 2;
		// Seed prior PREPARE acceptance for both candidates so this test isolates PRE-COMMIT vote memory.
		follower.acceptedPrepareByView.set(2, new Set(["pc-v2-A", "pc-v2-B"]));

		const preCommitA: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "pc-v2-A",
			justify: createQC("pc-v2-A", 2, MessageKind.Prepare),
		};
		const preCommitB: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "pc-v2-B",
			justify: createQC("pc-v2-B", 3, MessageKind.Prepare),
		};

		follower.message(preCommitA);
		follower.message(preCommitB);

		// Act
		await follower.step(nodes);

		// Assert
		const preCommitVotes = collectVotes(leaderForV2, MessageKind.PreCommit);
		expect(preCommitVotes).toHaveLength(1);
		expect(["pc-v2-A", "pc-v2-B"]).toContain(preCommitVotes[0]!.nodeHash);
		expect(preCommitVotes[0]!.senderId).toBe(follower.id);
	});

	/**
	 * Verifies PRE-COMMIT vote memory still permits progress into higher views.
	 * How: process one valid PRE-COMMIT in view 2, then one in view 3 from that view's leader;
	 * follower should emit one PRE-COMMIT vote per view.
	 */
	it("replica can emit PRE-COMMIT votes again after advancing to a higher view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [follower, n1, leaderForV2, leaderForV3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [follower, n1, leaderForV2, leaderForV3] as const;

		follower.replicaState.viewNumber = 2;
		// Seed prior PREPARE acceptance per view so this test isolates cross-view PRE-COMMIT vote memory.
		follower.acceptedPrepareByView.set(2, new Set(["pc-v2"]));
		follower.acceptedPrepareByView.set(3, new Set(["pc-v3"]));

		follower.message({
			type: MessageKind.PreCommit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "pc-v2",
			justify: createQC("pc-v2", 2, MessageKind.Prepare),
		});
		await follower.step(nodes);

		follower.message({
			type: MessageKind.PreCommit,
			viewNumber: 3,
			senderId: leaderForV3.id,
			nodeHash: "pc-v3",
			justify: createQC("pc-v3", 3, MessageKind.Prepare),
		});

		// Act
		await follower.step(nodes);

		// Assert
		const v2Votes = collectVotes(leaderForV2, MessageKind.PreCommit);
		const v3Votes = collectVotes(leaderForV3, MessageKind.PreCommit);
		expect(v2Votes).toHaveLength(1);
		expect(v3Votes).toHaveLength(1);
		expect(v2Votes[0]!.viewNumber).toBe(2);
		expect(v3Votes[0]!.viewNumber).toBe(3);
	});

	/**
	 * Verifies COMMIT vote memory enforces at most one vote per view.
	 * How: deliver two leader-valid COMMIT messages in the same view for different node hashes; second
	 * message carries a higher justify view so lock monotonicity alone cannot explain rejection. Follower
	 * should still emit only one COMMIT vote for that view.
	 */
	it("replica emits at most one COMMIT vote for conflicting messages in the same view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [follower, n1, leaderForV2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [follower, n1, leaderForV2, n3] as const;

		follower.replicaState.viewNumber = 2;
		// Seed prior PRE-COMMIT acceptance for both candidates so this test isolates COMMIT vote memory.
		follower.acceptedPreCommitByView.set(2, new Set(["c-v2-A", "c-v2-B"]));

		const commitA: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "c-v2-A",
			justify: createQC("c-v2-A", 2, MessageKind.PreCommit),
		};
		const commitB: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "c-v2-B",
			justify: createQC("c-v2-B", 3, MessageKind.PreCommit),
		};

		follower.message(commitA);
		follower.message(commitB);

		// Act
		await follower.step(nodes);

		// Assert
		const commitVotes = collectVotes(leaderForV2, MessageKind.Commit);
		expect(commitVotes).toHaveLength(1);
		expect(["c-v2-A", "c-v2-B"]).toContain(commitVotes[0]!.nodeHash);
		expect(commitVotes[0]!.senderId).toBe(follower.id);
	});

	/**
	 * Verifies COMMIT vote memory still permits progress into higher views.
	 * How: process one valid COMMIT in view 2 and then one in view 3 from that view's leader;
	 * follower should emit one COMMIT vote per view with monotonic lock progression.
	 */
	it("replica can emit COMMIT votes again after advancing to a higher view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [follower, n1, leaderForV2, leaderForV3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [follower, n1, leaderForV2, leaderForV3] as const;

		follower.replicaState.viewNumber = 2;
		// Seed prior PRE-COMMIT acceptance per view so this test isolates cross-view COMMIT vote memory.
		follower.acceptedPreCommitByView.set(2, new Set(["c-v2"]));
		follower.acceptedPreCommitByView.set(3, new Set(["c-v3"]));

		follower.message({
			type: MessageKind.Commit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "c-v2",
			justify: createQC("c-v2", 2, MessageKind.PreCommit),
		});
		await follower.step(nodes);

		follower.message({
			type: MessageKind.Commit,
			viewNumber: 3,
			senderId: leaderForV3.id,
			nodeHash: "c-v3",
			justify: createQC("c-v3", 3, MessageKind.PreCommit),
		});

		// Act
		await follower.step(nodes);

		// Assert
		const v2Votes = collectVotes(leaderForV2, MessageKind.Commit);
		const v3Votes = collectVotes(leaderForV3, MessageKind.Commit);
		expect(v2Votes).toHaveLength(1);
		expect(v3Votes).toHaveLength(1);
		expect(v2Votes[0]!.viewNumber).toBe(2);
		expect(v3Votes[0]!.viewNumber).toBe(3);
	});
});