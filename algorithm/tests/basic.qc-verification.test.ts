import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import {
	MessageKind,
	type CommitMessage,
	type DecideMessage,
	type NewViewMessage,
	type PreCommitMessage,
	type QuorumCertificate,
} from "../src/types.js";

/** Build a deterministic config so QC-verification scenarios stay isolated from timing noise. */
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

/** Helper to create a node with fresh in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Seed leader-only state so tests can drive one step at a time without the full run loop. */
function setLeaderState(node: BasicHotStuffNode) {
	node.leaderState = {
		...node.replicaState,
		pendingVotes: new Map(),
		collectedNewViews: [],
	};
}

/** Build a deterministic QC fixture that can be made valid or invalid per test. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

/** Clone a QC fixture but replace the signature with an obviously invalid payload. */
function createInvalidQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `invalid-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff QC verification entrypoints", () => {
	/**
	 * Verifies PRE-COMMIT rejects a structurally valid QC when its signature is invalid.
	 * How: deliver a PRE-COMMIT from the correct leader for the current view, but replace the QC
	 * signature with a bogus value, then assert the follower does not adopt the QC or send a vote.
	 */
	it("rejects PRE-COMMIT with an invalid QC signature", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [follower, n1, leaderForView2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [follower, n1, leaderForView2, n3] as const;

		follower.replicaState.viewNumber = 2;

		const preCommitMessage: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 2,
			senderId: leaderForView2.id,
			nodeHash: "qc-test-precommit",
			justify: createInvalidQC("qc-test-precommit", 2, MessageKind.Prepare),
		};

		follower.message(preCommitMessage);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.prepareQC).toBeNull();
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(leaderForView2.messageQueue).toHaveLength(0);
	});

	/**
	 * Verifies COMMIT rejects a structurally valid precommitQC when its signature is invalid.
	 * How: send a COMMIT from the correct leader for the current view, but make the carried QC
	 * signature bogus, then assert the follower does not lock or emit a COMMIT vote.
	 */
	it("rejects COMMIT with an invalid QC signature", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [follower, n1, leaderForView2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [follower, n1, leaderForView2, n3] as const;

		follower.replicaState.viewNumber = 2;

		const commitMessage: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 2,
			senderId: leaderForView2.id,
			nodeHash: "qc-test-commit",
			justify: createInvalidQC("qc-test-commit", 2, MessageKind.PreCommit),
		};

		follower.message(commitMessage);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.lockedQC).toBeNull();
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(leaderForView2.messageQueue).toHaveLength(0);
	});

	/**
	 * Verifies DECIDE rejects a structurally valid commitQC when its signature is invalid.
	 * How: seed the decided block so execution would succeed if accepted, then send a bogus DECIDE
	 * and assert that nothing is committed, nothing is executed, and the view does not advance.
	 */
	it("rejects DECIDE with an invalid QC signature", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [leader, follower, n2, decideLeader] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [leader, follower, n2, decideLeader] as const;

		follower.replicaState.viewNumber = 3;
		follower.knownBlocksByHash.set("qc-test-decide", {
			hash: "qc-test-decide",
			parentHash: "GENESIS",
			data: { writes: [{ key: "qc-key", value: "qc-value" }] },
			height: 1,
		});

		const decideMessage: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 3,
			senderId: decideLeader.id,
			nodeHash: "qc-test-decide",
			justify: createInvalidQC("qc-test-decide", 3, MessageKind.Commit),
		};

		follower.message(decideMessage);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.committedBlocks).toHaveLength(0);
		expect(follower.replicaState.viewNumber).toBe(3);
		expect(await follower.read("qc-key")).toBeNull();
	});

	/**
	 * Verifies NEW-VIEW evidence with invalid QC signatures is ignored by the leader.
	 * How: give a leader two bogus NEW-VIEW messages that would otherwise satisfy quorum, then
	 * assert it does not collect them as valid evidence or broadcast a PREPARE proposal.
	 */
	it("ignores invalid NEW-VIEW QC evidence when selecting highQC", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, leader, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, leader, n2, n3] as const;
		setLeaderState(leader);

		leader.replicaState.viewNumber = 1;
		leader.leaderState!.viewNumber = 1;
		void leader.put("qc-new-view-key", "qc-new-view-value");

		const invalidNewViewFromN0: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n0.id,
			lockedQC: createInvalidQC("nv-bad-a", 5, MessageKind.Prepare),
			partialSig: "nv-sig-a",
		};
		const invalidNewViewFromN2: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n2.id,
			lockedQC: createInvalidQC("nv-bad-b", 6, MessageKind.Prepare),
			partialSig: "nv-sig-b",
		};

		leader.message(invalidNewViewFromN0);
		leader.message(invalidNewViewFromN2);

		// Act
		await leader.step(nodes);

		// Assert
		expect(leader.leaderState!.collectedNewViews).toHaveLength(0);
		expect(n0.messageQueue.some((message) => message.type === MessageKind.Prepare)).toBe(false);
		expect(n2.messageQueue.some((message) => message.type === MessageKind.Prepare)).toBe(false);
		expect(n3.messageQueue.some((message) => message.type === MessageKind.Prepare)).toBe(false);
	});
});