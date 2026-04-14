import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import {
	MessageKind,
	type PrepareMessage,
	type QuorumCertificate,
	type VoteMessage,
} from "../src/types.js";

/** Build deterministic config for vote-monotonicity TDD scenarios. */
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

/** Build deterministic QC fixtures carried by PREPARE messages. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

/** Build a PREPARE message fixture where parent/justify are structurally valid. */
function createPrepare(senderId: number, viewNumber: number, blockHash: string): PrepareMessage {
	return {
		type: MessageKind.Prepare,
		viewNumber,
		senderId,
		node: {
			block: {
				hash: blockHash,
				parentHash: "GENESIS",
				data: { writes: [] },
				height: 1,
			},
			parentHash: "GENESIS",
			justify: createQC("GENESIS", Math.max(0, viewNumber - 1), MessageKind.NewView),
		},
	};
}

/** Collect PREPARE votes currently queued at the target leader. */
function collectPrepareVotes(node: BasicHotStuffNode): VoteMessage[] {
	return node.messageQueue.filter(
		(message): message is VoteMessage =>
			message.type === MessageKind.Vote && message.voteType === MessageKind.Prepare,
	);
}

describe("Basic HotStuff vote monotonicity guards", () => {
	/**
	 * Verifies duplicate PREPARE for the same proposal/view does not produce duplicate votes.
	 * How: enqueue the exact same valid PREPARE twice from the correct leader for view 2,
	 * process one step, then assert the leader receives only one PREPARE vote from follower.
	 */
	it("replica emits at most one PREPARE vote for duplicate proposal in the same view", async () => {
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

		const duplicate = createPrepare(leaderForV2.id, 2, "dup-block");
		follower.message(duplicate);
		follower.message(duplicate);

		// Act
		await follower.step(nodes);

		// Assert
		const votes = collectPrepareVotes(leaderForV2);
		expect(votes).toHaveLength(1);
		expect(votes[0]!.nodeHash).toBe("dup-block");
		expect(votes[0]!.senderId).toBe(follower.id);
	});

	/**
	 * Verifies conflicting PREPARE proposals in the same view do not cause double voting.
	 * How: enqueue two different valid proposals for view 2 from the correct leader,
	 * process one step, then assert only one PREPARE vote is emitted for that view.
	 */
	it("replica does not vote for conflicting proposals within the same view", async () => {
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

		const proposalA = createPrepare(leaderForV2.id, 2, "view2-A");
		const proposalB = createPrepare(leaderForV2.id, 2, "view2-B");
		follower.message(proposalA);
		follower.message(proposalB);

		// Act
		await follower.step(nodes);

		// Assert
		const votes = collectPrepareVotes(leaderForV2);
		expect(votes).toHaveLength(1);
		expect(["view2-A", "view2-B"]).toContain(votes[0]!.nodeHash);
	});

	/**
	 * Verifies monotonic voting still allows progress into higher views.
	 * How: process one valid PREPARE in view 2 (leader node 2) and one in view 3
	 * (leader node 3), then assert one vote is emitted per view to the matching leaders.
	 */
	it("replica can vote again after advancing to a higher view", async () => {
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
		follower.message(createPrepare(leaderForV2.id, 2, "v2-block"));
		await follower.step(nodes);

		follower.message(createPrepare(leaderForV3.id, 3, "v3-block"));

		// Act
		await follower.step(nodes);

		// Assert
		const v2Votes = collectPrepareVotes(leaderForV2);
		const v3Votes = collectPrepareVotes(leaderForV3);
		expect(v2Votes).toHaveLength(1);
		expect(v3Votes).toHaveLength(1);
		expect(v2Votes[0]!.viewNumber).toBe(2);
		expect(v3Votes[0]!.viewNumber).toBe(3);
	});

	/**
	 * Verifies stale PREPARE messages are ignored after the replica has already voted in a newer view.
	 * How: accept a valid PREPARE in view 3 first, then deliver a late PREPARE for view 2,
	 * and assert no extra PREPARE vote is emitted for the older view.
	 */
	it("replica ignores late PREPARE from an older view after voting in a newer view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [follower, n1, leaderForV2, leaderForV3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [follower, n1, leaderForV2, leaderForV3] as const;

		follower.replicaState.viewNumber = 3;
		follower.message(createPrepare(leaderForV3.id, 3, "v3-first"));
		await follower.step(nodes);

		follower.message(createPrepare(leaderForV2.id, 2, "v2-late"));

		// Act
		await follower.step(nodes);

		// Assert
		const v2Votes = collectPrepareVotes(leaderForV2);
		const v3Votes = collectPrepareVotes(leaderForV3);
		expect(v3Votes).toHaveLength(1);
		expect(v2Votes).toHaveLength(0);
		expect(follower.replicaState.viewNumber).toBeGreaterThanOrEqual(3);
	});
});
