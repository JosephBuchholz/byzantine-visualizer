import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../../src/index.js";
import BasicHotStuffNode from "../../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../../src/data/store.js";
import {
	MessageKind,
	type PrepareMessage,
	type QuorumCertificate,
	type VoteMessage,
} from "../../src/types.js";

/** Build deterministic config for path-level educational scenarios. */
function createTestConfig(overrides?: Partial<Required<HotStuffConfig>>): Required<HotStuffConfig> {
	return {
		numNodes: 4,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 100,
		maxBatchSize: 1,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
		...overrides,
	};
}

/** Helper to create isolated test nodes with fresh in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Build deterministic QC fixtures accepted by simulator verification. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

/** Build a leader-authenticated PREPARE for a specific proposal hash. */
function createPrepare(leaderId: number, viewNumber: number, proposalHash: string): PrepareMessage {
	return {
		type: MessageKind.Prepare,
		viewNumber,
		senderId: leaderId,
		node: {
			block: {
				hash: proposalHash,
				parentHash: "GENESIS",
				data: { writes: [{ key: proposalHash, value: proposalHash }] },
				height: 1,
			},
			parentHash: "GENESIS",
			justify: createQC("GENESIS", 1, MessageKind.NewView),
		},
	};
}

describe("Basic HotStuff Path 3A equivocation scenario", () => {
	/**
	 * Path 3A: equivocation narrative where one leader sends conflicting PREPAREs in the same view.
	 *
	 * What this test demonstrates:
	 * A byzantine leader can send proposal A to one replica and proposal B to another in the same
	 * view, but this does not let the system form a PREPARE QC from conflicting votes.
	 *
	 * How it demonstrates it:
	 * 1) Put all replicas in view 2 where node 2 is deterministic leader.
	 * 2) Deliver PREPARE(A) to one follower and PREPARE(B) to another follower.
	 * 3) Process followers and assert leader receives two PREPARE votes for different node hashes.
	 * 4) Process leader and assert no PRE-COMMIT is broadcast and no commit occurs.
	 */
	it("Path 3A: conflicting same-view PREPAREs from leader do not create a quorum certificate", async () => {
		// Arrange
		const config = createTestConfig();
		const [followerA, followerB, leaderV2, observer] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [followerA, followerB, leaderV2, observer] as const;

		for (const node of nodes) {
			node.replicaState.viewNumber = 2;
		}

		const prepareA = createPrepare(leaderV2.id, 2, "path3a-A");
		const prepareB = createPrepare(leaderV2.id, 2, "path3a-B");

		// Byzantine split delivery: different followers receive different proposals for same view.
		followerA.message(prepareA);
		followerB.message(prepareB);

		// Act
		await followerA.step(nodes);
		await followerB.step(nodes);

		// Assert intermediate state: leader has conflicting PREPARE votes but no single-hash quorum.
		const prepareVotesAtLeader = leaderV2.messageQueue.filter(
			(message): message is VoteMessage =>
				message.type === MessageKind.Vote && message.voteType === MessageKind.Prepare,
		);
		expect(prepareVotesAtLeader).toHaveLength(2);
		expect(new Set(prepareVotesAtLeader.map((vote) => vote.nodeHash))).toEqual(
			new Set(["path3a-A", "path3a-B"]),
		);

		await leaderV2.step(nodes);

		// Assert final state: without 2f+1 matching PREPARE votes, protocol cannot advance this branch.
		const preCommitBroadcastSeen =
			followerA.messageQueue.some((message) => message.type === MessageKind.PreCommit) ||
			followerB.messageQueue.some((message) => message.type === MessageKind.PreCommit) ||
			observer.messageQueue.some((message) => message.type === MessageKind.PreCommit);
		expect(preCommitBroadcastSeen).toBe(false);
		expect(nodes.every((node) => node.replicaState.committedBlocks.length === 0)).toBe(true);
	});
});
