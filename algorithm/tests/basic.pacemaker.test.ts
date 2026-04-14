import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import { MessageKind, type NewViewMessage, type QuorumCertificate } from "../src/types.js";

/** Build deterministic config for pacemaker-style liveness orchestration tests. */
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

/** Helper to create isolated nodes with fresh in-memory state per scenario. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Seed leader-only state in tests that bypass the long-running run loop. */
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

describe("Basic HotStuff pacemaker liveness orchestration", () => {
	/**
	 * Verifies NEW-VIEW quorum accounting includes the leader's own local evidence.
	 * How: in n=4 (quorum 3), provide only two external NEW-VIEW messages plus leader's local QC,
	 * then trigger a beat (client command) and expect proposal to proceed.
	 * This guards against regressions in leader self-evidence quorum accounting.
	 */
	it("leader can propose with n-f-1 external NEW-VIEW messages plus self evidence", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, leader, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, leader, n3] as const;
		setLeaderState(leader);

		leader.replicaState.viewNumber = 2;
		leader.leaderState!.viewNumber = 2;
		leader.replicaState.prepareQC = createQC("leader-self-qc", 6, MessageKind.Prepare);

		const nvFromN1: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 2,
			senderId: n1.id,
			lockedQC: createQC("n1-qc", 4, MessageKind.Prepare),
			partialSig: "nv-1",
		};
		const nvFromN2: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 2,
			senderId: n0.id,
			lockedQC: createQC("n0-qc", 5, MessageKind.Prepare),
			partialSig: "nv-2",
		};

		leader.message(nvFromN1);
		leader.message(nvFromN2);
		void leader.put("beat-key", "beat-value");

		// Act
		await leader.step(nodes);

		// Assert
		expect(n0.messageQueue.some((m) => m.type === MessageKind.Prepare)).toBe(true);
		expect(n1.messageQueue.some((m) => m.type === MessageKind.Prepare)).toBe(true);
		expect(n3.messageQueue.some((m) => m.type === MessageKind.Prepare)).toBe(true);
	});

	/**
	 * Verifies onReceiveNewView is robust to repeated sender updates in the same view.
	 * How: deliver two NEW-VIEW messages from the same sender where the second carries higher QC,
	 * then assert the leader keeps the freshest evidence for highQC selection.
	 * This guards against regressions in per-sender NEW-VIEW evidence replacement logic.
	 */
	it("onReceiveNewView keeps highest evidence from repeated sender updates", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, leader] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, leader] as const;
		setLeaderState(leader);

		leader.replicaState.viewNumber = 3;
		leader.leaderState!.viewNumber = 3;

		const olderFromN1: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 3,
			senderId: n1.id,
			lockedQC: createQC("n1-old", 2, MessageKind.Prepare),
			partialSig: "nv-n1-old",
		};
		const newerFromN1: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 3,
			senderId: n1.id,
			lockedQC: createQC("n1-new", 9, MessageKind.Prepare),
			partialSig: "nv-n1-new",
		};
		const fromN2: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 3,
			senderId: n2.id,
			lockedQC: createQC("n2-mid", 5, MessageKind.Prepare),
			partialSig: "nv-n2",
		};
		const fromN3: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 3,
			senderId: n0.id,
			lockedQC: createQC("n0-low", 4, MessageKind.Prepare),
			partialSig: "nv-n0",
		};

		leader.message(olderFromN1);
		leader.message(newerFromN1);
		leader.message(fromN2);
		leader.message(fromN3);
		void leader.put("carry-key", "carry-value");

		// Act
		await leader.step(nodes);

		// Assert
		const prepareMessage = n2.messageQueue.find((message) => message.type === MessageKind.Prepare);
		expect(prepareMessage).toBeDefined();
		if (prepareMessage?.type === MessageKind.Prepare) {
			expect(prepareMessage.node.justify.nodeHash).toBe("n1-new");
			expect(prepareMessage.node.justify.viewNumber).toBe(9);
		}
	});

	/**
	 * Verifies propose-on-beat sequencing with collected NEW-VIEW evidence.
	 * How: first collect quorum NEW-VIEW messages with no pending command and assert no proposal,
	 * then submit one client write as beat and assert next step produces PREPARE using collected highQC.
	 */
	it("collect-highQC first and propose only after beat arrives", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [leader, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [leader, n1, n2, n3] as const;
		setLeaderState(leader);

		leader.replicaState.viewNumber = 4;
		leader.leaderState!.viewNumber = 4;

		leader.message({
			type: MessageKind.NewView,
			viewNumber: 4,
			senderId: n1.id,
			lockedQC: createQC("low", 3, MessageKind.Prepare),
			partialSig: "nv-1",
		});
		leader.message({
			type: MessageKind.NewView,
			viewNumber: 4,
			senderId: n2.id,
			lockedQC: createQC("high", 10, MessageKind.Prepare),
			partialSig: "nv-2",
		});
		leader.message({
			type: MessageKind.NewView,
			viewNumber: 4,
			senderId: n3.id,
			lockedQC: createQC("mid", 7, MessageKind.Prepare),
			partialSig: "nv-3",
		});

		// Act
		await leader.step(nodes);

		// Assert (no beat yet)
		expect(n1.messageQueue.some((message) => message.type === MessageKind.Prepare)).toBe(false);

		// Act (beat arrives)
		void leader.put("beat", "value");
		await leader.step(nodes);

		// Assert (proposal after beat, anchored to collected highQC)
		const prepareMessage = n1.messageQueue.find((message) => message.type === MessageKind.Prepare);
		expect(prepareMessage).toBeDefined();
		if (prepareMessage?.type === MessageKind.Prepare) {
			expect(prepareMessage.node.justify.nodeHash).toBe("high");
			expect(prepareMessage.node.justify.viewNumber).toBe(10);
		}
	});
});
