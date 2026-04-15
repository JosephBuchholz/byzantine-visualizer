import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import { MessageKind, type NewViewMessage, type QuorumCertificate } from "../src/types.js";

/** Build a deterministic config so NEW-VIEW semantics tests stay isolated from timing noise. */
function createTestConfig(numNodes = 4): Required<HotStuffConfig> {
	return {
		numNodes,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 1,
		maxBatchSize: 1,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
	};
}

/** Helper to create a node with fresh in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Seed leader-only state so a node can collect NEW-VIEW evidence in a step-driven test. */
function setLeaderState(node: BasicHotStuffNode) {
	node.leaderState = {
		...node.replicaState,
		pendingVotes: new Map(),
		collectedNewViews: [],
	};
}

/** Build a deterministic QC fixture used as NEW-VIEW evidence. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff NEW-VIEW prepareQC semantics", () => {
	/**
	 * Verifies a replica does not fall back to lockedQC when it exits a view without a prepareQC.
	 * How: give the replica a high lockedQC, leave prepareQC empty, force a timeout transition, and
	 * assert the emitted NEW-VIEW uses the neutral genesis-style evidence instead of the lock.
	 */
	it("timeout-driven NEW-VIEW does not leak lockedQC when prepareQC is absent", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, replica, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, replica, n3] as const;

		replica.replicaState.viewNumber = 5;
		replica.replicaState.prepareQC = null;
		replica.replicaState.lockedQC = createQC("locked-only", 9, MessageKind.PreCommit);

		// Act
		await replica.step(nodes);
		await replica.step(nodes);

		// Assert
		expect(replica.replicaState.viewNumber).toBe(6);
		const nextLeader = nodes[6 % nodes.length]!;
		const newView = nextLeader.messageQueue.find(
			(message): message is NewViewMessage => message.type === MessageKind.NewView,
		);
		expect(newView).toBeDefined();
		if (newView) {
			expect(newView.senderId).toBe(replica.id);
			expect(newView.viewNumber).toBe(6);
			expect(newView.prepareQC.nodeHash).toBe("GENESIS");
		}
	});

	/**
	 * Verifies highQC selection prefers NEW-VIEW evidence over a stronger local lockedQC fallback.
	 * How: seed the leader with a high local lock but no prepareQC, supply lower NEW-VIEW evidence,
	 * and assert the proposed PREPARE is anchored to the NEW-VIEW evidence rather than the lock.
	 */
	it("leader highQC selection ignores local lockedQC when only NEW-VIEW evidence should matter", async () => {
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
		leader.replicaState.prepareQC = null;
		leader.replicaState.lockedQC = createQC("leader-locked-high", 9, MessageKind.PreCommit);
		void leader.put("nv-prepareqc-key", "nv-prepareqc-value");

		const lowEvidence: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n0.id,
			prepareQC: createQC("low-evidence", 3, MessageKind.Prepare),
			partialSig: "nv-low",
		};
		const higherEvidence: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: n2.id,
			prepareQC: createQC("higher-evidence", 6, MessageKind.Prepare),
			partialSig: "nv-high",
		};

		leader.message(lowEvidence);
		leader.message(higherEvidence);

		// Act
		await leader.step(nodes);

		// Assert
		const prepare = n0.messageQueue.find((message) => message.type === MessageKind.Prepare);
		expect(prepare).toBeDefined();
		if (prepare?.type === MessageKind.Prepare) {
			expect(prepare.node.justify.nodeHash).toBe("higher-evidence");
			expect(prepare.node.justify.viewNumber).toBe(6);
		}
	});
});