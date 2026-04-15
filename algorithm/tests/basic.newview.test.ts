import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import { MessageKind, type NewViewMessage, type QuorumCertificate } from "../src/types.js";

/** Build deterministic config for NEW-VIEW protocol TDD scenarios. */
function createTestConfig(numNodes = 4): Required<HotStuffConfig> {
	return {
		numNodes,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 100,
		maxBatchSize: 1,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
	};
}

/** Helper to create a node with isolated in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Seed leader-only state for tests that bypass the full run loop. */
function setLeaderState(node: BasicHotStuffNode) {
	node.leaderState = {
		...node.replicaState,
		pendingVotes: new Map(),
		collectedNewViews: [],
	};
}

/** Build deterministic QC fixtures carried inside NEW-VIEW messages. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff NEW-VIEW protocol processing", () => {
	/**
	 * Verifies runtime NEW-VIEW handling in the step loop.
	 * How: enqueue NEW-VIEW messages to the current leader and assert they are collected in
	 * leader state (deduplicated by sender) for view-change processing.
	 * This guards against regressions in NEW-VIEW handling inside the step loop.
	 */
	it("leader collects NEW-VIEW messages in step loop", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, leader, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, leader, n2, n3] as const;

		// Use view 1 so node 1 is the deterministic leader for this scenario.
		leader.replicaState.viewNumber = 1;
		setLeaderState(leader);
		leader.leaderState!.viewNumber = 1;

		const nv1: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n0.id,
			prepareQC: createQC("block-a", 4, MessageKind.Prepare),
			partialSig: "nv-sig-1",
		};
		const nv2: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n2.id,
			prepareQC: createQC("block-b", 5, MessageKind.Prepare),
			partialSig: "nv-sig-2",
		};
		const duplicateFromN2: NewViewMessage = {
			...nv2,
			partialSig: "nv-sig-2-dup",
		};

		leader.message(nv1);
		leader.message(nv2);
		leader.message(duplicateFromN2);

		// Act
		await leader.step(nodes);

		// Assert
		expect(leader.leaderState).not.toBeNull();
		expect(leader.leaderState!.collectedNewViews.map((message) => message.senderId)).toEqual([
			n0.id,
			n2.id,
		]);
	});

	/**
	 * Verifies leaders do not propose before NEW-VIEW quorum is reached.
	 * How: provide pending client work but no NEW-VIEW quorum, run one leader step, and assert no
	 * PREPARE is broadcast yet.
	 * This guards against regressions in NEW-VIEW quorum gating before proposal.
	 */
	it("leader does not broadcast PREPARE before NEW-VIEW quorum", async () => {
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
		void leader.put("nv-key", "nv-value");

		// Act
		await leader.step(nodes);

		// Assert
		expect(n0.messageQueue.some((m) => m.type === MessageKind.Prepare)).toBe(false);
		expect(n2.messageQueue.some((m) => m.type === MessageKind.Prepare)).toBe(false);
		expect(n3.messageQueue.some((m) => m.type === MessageKind.Prepare)).toBe(false);
	});

	/**
	 * Verifies highQC selection once NEW-VIEW quorum is collected.
	 * How: send quorum NEW-VIEW messages with different QC view numbers, then trigger leader
	 * proposal and assert PREPARE.justify carries the highest-view QC among collected evidence.
	 * This guards against regressions in highest-QC selection from NEW-VIEW evidence.
	 */
	it("leader selects highest QC from NEW-VIEW quorum when proposing", async () => {
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

		const lowQC = createQC("low-qc-block", 2, MessageKind.Prepare);
		const highQC = createQC("high-qc-block", 7, MessageKind.Prepare);
		const midQC = createQC("mid-qc-block", 5, MessageKind.Prepare);

		const nv1: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n0.id,
			prepareQC: lowQC,
			partialSig: "nv-low",
		};
		const nv2: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n2.id,
			prepareQC: highQC,
			partialSig: "nv-high",
		};
		const nv3: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n3.id,
			prepareQC: midQC,
			partialSig: "nv-mid",
		};

		leader.message(nv1);
		leader.message(nv2);
		leader.message(nv3);
		void leader.put("carry-key", "carry-value");

		// Act
		await leader.step(nodes);

		// Assert
		const prepareMessage = n0.messageQueue.find((message) => message.type === MessageKind.Prepare);
		expect(prepareMessage).toBeDefined();
		if (prepareMessage?.type === MessageKind.Prepare) {
			expect(prepareMessage.node.justify.nodeHash).toBe(highQC.nodeHash);
			expect(prepareMessage.node.justify.viewNumber).toBe(highQC.viewNumber);
		}
	});
});
