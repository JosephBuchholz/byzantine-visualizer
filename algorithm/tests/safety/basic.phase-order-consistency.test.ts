import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../../src/index.js";
import BasicHotStuffNode from "../../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../../src/data/store.js";
import {
	MessageKind,
	type CommitMessage,
	type DecideMessage,
	type PreCommitMessage,
	type QuorumCertificate,
} from "../../src/types.js";

/** Build deterministic config for phase-order and view-consistency TDD scenarios. */
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

/** Build deterministic QC fixtures accepted by simulator verification. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff strict phase-order and justify-view consistency", () => {
	/**
	 * Verifies PRE-COMMIT rejects justify-view mismatch.
	 * How: deliver PRE-COMMIT in view v with a QC for view v-1 while all other fields are valid,
	 * then assert follower neither updates prepareQC nor emits a PRE-COMMIT vote.
	 */
	it("rejects PRE-COMMIT when justify view does not match message view", async () => {
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

		const message: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "pc-view-mismatch",
			justify: createQC("pc-view-mismatch", 1, MessageKind.Prepare),
		};
		follower.message(message);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.prepareQC).toBeNull();
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(leaderForV2.messageQueue).toHaveLength(0);
	});

	/**
	 * Verifies COMMIT rejects justify-view mismatch.
	 * How: deliver COMMIT in view v with a precommitQC for view v-1 and assert the follower
	 * does not update lock state and does not emit a COMMIT vote.
	 */
	it("rejects COMMIT when justify view does not match message view", async () => {
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

		const message: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "c-view-mismatch",
			justify: createQC("c-view-mismatch", 1, MessageKind.PreCommit),
		};
		follower.message(message);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.lockedQC).toBeNull();
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(leaderForV2.messageQueue).toHaveLength(0);
	});

	/**
	 * Verifies DECIDE rejects justify-view mismatch.
	 * How: seed the decided block locally, then deliver DECIDE in view v with commitQC from v-1;
	 * follower must not execute writes, append commits, or advance view.
	 */
	it("rejects DECIDE when justify view does not match message view", async () => {
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
		follower.knownBlocksByHash.set("d-view-mismatch", {
			hash: "d-view-mismatch",
			parentHash: "GENESIS",
			data: { writes: [{ key: "phase-order-key", value: "phase-order-value" }] },
			height: 1,
		});

		const message: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "d-view-mismatch",
			justify: createQC("d-view-mismatch", 1, MessageKind.Commit),
		};
		follower.message(message);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.committedBlocks).toHaveLength(0);
		expect(follower.replicaState.viewNumber).toBe(2);
		expect(await follower.read("phase-order-key")).toBeNull();
	});

	/**
	 * Verifies strict phase order: PRE-COMMIT must require prior PREPARE acceptance in the same view.
	 * How: deliver a valid PRE-COMMIT first (without any earlier PREPARE for that node/view) and
	 * assert no PRE-COMMIT vote is emitted.
	 */
	it("rejects PRE-COMMIT when no prior PREPARE was accepted for that view", async () => {
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

		const message: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "pc-without-prepare",
			justify: createQC("pc-without-prepare", 2, MessageKind.Prepare),
		};
		follower.message(message);

		// Act
		await follower.step(nodes);

		// Assert
		expect(leaderForV2.messageQueue).toHaveLength(0);
	});

	/**
	 * Verifies strict phase order: COMMIT must require prior PRE-COMMIT acceptance in the same view.
	 * How: deliver a valid COMMIT first and assert follower does not lock or emit COMMIT vote when
	 * PRE-COMMIT has not been accepted beforehand.
	 */
	it("rejects COMMIT when no prior PRE-COMMIT was accepted for that view", async () => {
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

		const message: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "c-without-precommit",
			justify: createQC("c-without-precommit", 2, MessageKind.PreCommit),
		};
		follower.message(message);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.lockedQC).toBeNull();
		expect(leaderForV2.messageQueue).toHaveLength(0);
	});

	/**
	 * Verifies strict phase order: DECIDE must require prior COMMIT acceptance in the same view.
	 * How: seed decided block locally, then deliver a valid DECIDE without prior COMMIT and assert
	 * no execution and no commit append.
	 */
	it("rejects DECIDE when no prior COMMIT was accepted for that view", async () => {
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
		follower.knownBlocksByHash.set("d-without-commit", {
			hash: "d-without-commit",
			parentHash: "GENESIS",
			data: { writes: [{ key: "decide-without-commit-key", value: "value" }] },
			height: 1,
		});

		const message: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 2,
			senderId: leaderForV2.id,
			nodeHash: "d-without-commit",
			justify: createQC("d-without-commit", 2, MessageKind.Commit),
		};
		follower.message(message);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.committedBlocks).toHaveLength(0);
		expect(await follower.read("decide-without-commit-key")).toBeNull();
	});
});
