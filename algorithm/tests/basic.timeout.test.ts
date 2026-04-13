import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import { MessageKind, type NewViewMessage, type QuorumCertificate } from "../src/types.js";

/** Build deterministic config for timeout/interrupt liveness scenarios. */
function createTestConfig(numNodes = 4): Required<HotStuffConfig> {
	return {
		numNodes,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 1,
		maxBatchSize: 10,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
	};
}

/** Helper to create isolated nodes for timeout mechanics tests. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Build deterministic QC fixtures used as qc_high evidence in NEW-VIEW messages. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff timeout/interrupt liveness", () => {
	/**
	 * Verifies protocol-level timeout interrupt performs explicit leader change and NEW-VIEW rebroadcast.
	 * How: keep one replica idle so no phase progress occurs, wait for timeout transition from view v to v+1,
	 * and assert the NEW-VIEW message is sent to the deterministic leader of the new view with carried qc evidence.
	 */
	it("timeout interrupt increments view and re-broadcasts NEW-VIEW to next leader", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		n2.replicaState.viewNumber = 5;
		n2.replicaState.prepareQC = createQC("qc-v5", 5, MessageKind.Prepare);

		// Act
		await n2.step(nodes);
		await n2.step(nodes);

		// Assert
		expect(n2.replicaState.viewNumber).toBe(6);
		const newLeader = nodes[6 % nodes.length]!;
		const newView = newLeader.messageQueue.find(
			(message): message is NewViewMessage => message.type === MessageKind.NewView,
		);
		expect(newView).toBeDefined();
		if (newView) {
			expect(newView.senderId).toBe(n2.id);
			expect(newView.viewNumber).toBe(6);
			expect(newView.lockedQC.nodeHash).toBe("qc-v5");
		}
	});

	/**
	 * Verifies repeated timeouts re-broadcast NEW-VIEW for each successive leader change.
	 * How: force two timeout transitions in a row with no progress and assert that each target leader
	 * receives a NEW-VIEW for its corresponding view, proving per-view re-broadcast behavior.
	 */
	it("repeated timeout interrupts re-broadcast NEW-VIEW for each new view", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		n2.replicaState.viewNumber = 3;
		n2.replicaState.prepareQC = createQC("qc-v3", 3, MessageKind.Prepare);

		// Act
		await n2.step(nodes);
		await n2.step(nodes);
		await n2.step(nodes);
		await n2.step(nodes);

		// Assert
		expect(n2.replicaState.viewNumber).toBeGreaterThanOrEqual(5);

		const leaderForV4 = nodes[4 % nodes.length]!;
		const newViewToV4 = leaderForV4.messageQueue.find(
			(message): message is NewViewMessage =>
				message.type === MessageKind.NewView && message.viewNumber === 4 && message.senderId === n2.id,
		);
		expect(newViewToV4).toBeDefined();

		const leaderForV5 = nodes[5 % nodes.length]!;
		const newViewToV5 = leaderForV5.messageQueue.find(
			(message): message is NewViewMessage =>
				message.type === MessageKind.NewView && message.viewNumber === 5 && message.senderId === n2.id,
		);
		expect(newViewToV5).toBeDefined();
	});

	/**
	 * Verifies exponential backoff behavior across consecutive failed views.
	 * How: with base timeout = 1 step, trigger first timeout (to view+1), then run exactly two idle steps.
	 * Under exponential backoff, second timeout should need a longer wait and must NOT fire yet.
	 * This is expected to fail until timeout intervals grow after each failed view.
	 */
	it("timeout threshold grows across consecutive failed views (exponential backoff)", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		n2.replicaState.viewNumber = 8;
		n2.replicaState.prepareQC = createQC("qc-v8", 8, MessageKind.Prepare);

		// First timeout transition should happen after base threshold.
		await n2.step(nodes);
		await n2.step(nodes);
		expect(n2.replicaState.viewNumber).toBe(9);

		// Act: two more idle steps should be insufficient if timeout interval doubled.
		await n2.step(nodes);
		await n2.step(nodes);

		// Assert
		expect(n2.replicaState.viewNumber).toBe(9);
	});
});
