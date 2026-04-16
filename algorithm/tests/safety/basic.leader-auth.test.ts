import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../../src/index.js";
import BasicHotStuffNode from "../../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../../src/data/store.js";
import {
	MessageKind,
	type CommitMessage,
	type DecideMessage,
	type PreCommitMessage,
	type PrepareMessage,
	type QuorumCertificate,
} from "../../src/types.js";

/** Build deterministic config for leader-authentication TDD scenarios. */
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

/** Helper to create a node with isolated in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Build deterministic QC fixtures used by phase message setup. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff phase-leader authentication", () => {
	/**
	 * TDD red test: PREPARE must be accepted only from the deterministic leader of message.viewNumber.
	 * How: send a structurally valid/safe PREPARE for view 2 from a non-leader sender and assert
	 * follower emits no vote and does not advance prepare state.
	 */
	it("rejects PREPARE from non-leader sender for that view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		const follower = n3;
		const staleLeader = n1; // view 1 leader, but not leader for view 2
		const expectedLeader = n2; // deterministic leader for view 2 in n=4

		follower.replicaState.viewNumber = 2;

		const prepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 2,
			senderId: staleLeader.id,
			node: {
				block: {
					hash: "v2-block",
					parentHash: "GENESIS",
					data: { writes: [] },
					height: 1,
				},
				parentHash: "GENESIS",
				justify: createQC("GENESIS", 1, MessageKind.NewView),
			},
		};

		follower.message(prepare);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.prepareQC).toBeNull();
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(staleLeader.messageQueue.length).toBe(0);
		expect(expectedLeader.messageQueue.length).toBe(0);
	});

	/**
	 * TDD red test: PRE-COMMIT must be accepted only from the deterministic leader of message.viewNumber.
	 * How: send a valid PRE-COMMIT for view 2 from a non-leader sender and assert follower does not
	 * update prepareQC and emits no PRE-COMMIT vote.
	 */
	it("rejects PRE-COMMIT from non-leader sender for that view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		const follower = n0;
		const staleLeader = n1;
		const expectedLeader = n2;

		follower.replicaState.viewNumber = 2;

		const preCommit: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 2,
			senderId: staleLeader.id,
			nodeHash: "v2-block",
			justify: createQC("v2-block", 2, MessageKind.Prepare),
		};

		follower.message(preCommit);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.prepareQC).toBeNull();
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(staleLeader.messageQueue.length).toBe(0);
		expect(expectedLeader.messageQueue.length).toBe(0);
	});

	/**
	 * TDD red test: COMMIT must be accepted only from the deterministic leader of message.viewNumber.
	 * How: send a valid COMMIT for view 2 from a non-leader sender and assert follower does not
	 * update lockedQC and emits no COMMIT vote.
	 */
	it("rejects COMMIT from non-leader sender for that view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		const follower = n0;
		const staleLeader = n1;
		const expectedLeader = n2;

		follower.replicaState.viewNumber = 2;

		const commit: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 2,
			senderId: staleLeader.id,
			nodeHash: "v2-block",
			justify: createQC("v2-block", 2, MessageKind.PreCommit),
		};

		follower.message(commit);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.lockedQC).toBeNull();
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(staleLeader.messageQueue.length).toBe(0);
		expect(expectedLeader.messageQueue.length).toBe(0);
	});

	/**
	 * TDD red test: DECIDE must be accepted only from the deterministic leader of message.viewNumber.
	 * How: send a valid DECIDE for view 2 from a non-leader sender and assert follower does not execute,
	 * does not append committed blocks, and does not transition view.
	 */
	it("rejects DECIDE from non-leader sender for that view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		const follower = n0;
		const staleLeader = n1;

		follower.replicaState.viewNumber = 2;
		follower.knownBlocksByHash.set("v2-block", {
			hash: "v2-block",
			parentHash: "GENESIS",
			data: { writes: [{ key: "decide-key", value: "decide-value" }] },
			height: 1,
		});

		const decide: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 2,
			senderId: staleLeader.id,
			nodeHash: "v2-block",
			justify: createQC("v2-block", 2, MessageKind.Commit),
		};

		follower.message(decide);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.committedBlocks).toHaveLength(0);
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(await follower.read("decide-key")).toBeNull();
	});
});
