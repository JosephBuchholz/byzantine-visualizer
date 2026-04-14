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
	type PrepareMessage,
	type QuorumCertificate,
} from "../src/types.js";

/** Build deterministic config for view-transition and nextView protocol tests. */
function createTestConfig(numNodes = 3): Required<HotStuffConfig> {
	return {
		numNodes,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 1,
		maxBatchSize: 10,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
	};
}

/** Helper to create isolated nodes for each view-transition scenario. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Build deterministic QC fixtures used by PRE-COMMIT/COMMIT/DECIDE setup. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff view transition mechanics", () => {
	/**
	 * Verifies completion-driven nextView transition sends NEW-VIEW to the next leader.
	 * How: drive a follower through a valid PREPARE -> PRE-COMMIT -> COMMIT -> DECIDE sequence,
	 * then assert it increments view and emits a NEW-VIEW message to the deterministic next leader
	 * carrying its highest known QC evidence.
	 * This is expected to fail until explicit post-completion nextView signaling is implemented.
	 */
	it("after DECIDE, replica enters next view and sends NEW-VIEW to next leader", async () => {
		// Arrange
		const config = createTestConfig(3);
		const [replica, nextLeader, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [replica, nextLeader, other] as const;

		replica.replicaState.viewNumber = 9;

		const prepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 9,
			// In n=3, view 9 leader is node 0.
			senderId: replica.id,
			node: {
				block: {
					hash: "v9-block",
					parentHash: "GENESIS",
					data: { writes: [{ key: "k", value: "v" }] },
					height: 1,
				},
				parentHash: "GENESIS",
				justify: createQC("GENESIS", 8, MessageKind.NewView),
			},
		};
		const preCommit: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 9,
			senderId: replica.id,
			nodeHash: "v9-block",
			justify: createQC("v9-block", 9, MessageKind.Prepare),
		};
		const commit: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 9,
			senderId: replica.id,
			nodeHash: "v9-block",
			justify: createQC("v9-block", 9, MessageKind.PreCommit),
		};
		const decide: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 9,
			senderId: replica.id,
			nodeHash: "v9-block",
			justify: createQC("v9-block", 9, MessageKind.Commit),
		};

		replica.message(prepare);
		replica.message(preCommit);
		replica.message(commit);
		replica.message(decide);

		// Act
		await replica.step(nodes);

		// Assert
		expect(replica.replicaState.viewNumber).toBe(10);

		const newView = nextLeader.messageQueue.find(
			(message): message is NewViewMessage => message.type === MessageKind.NewView,
		);
		expect(newView).toBeDefined();
		if (newView) {
			expect(newView.viewNumber).toBe(10);
			expect(newView.senderId).toBe(replica.id);
			expect(newView.lockedQC.nodeHash).toBe("v9-block");
		}
	});

	/**
	 * Verifies timeout-driven nextView transition and NEW-VIEW signaling.
	 * How: keep a replica in a view with no progress and repeatedly tick step; expected behavior is
	 * timeout interrupt, view increment, and NEW-VIEW send to the next view leader with qc evidence.
	 * This is expected to fail until timeout/interrupt path and explicit nextView are implemented.
	 */
	it("on timeout interrupt, replica enters next view and sends NEW-VIEW", async () => {
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
		n2.replicaState.prepareQC = createQC("prepared-v3", 3, MessageKind.Prepare);

		// Act
		for (let i = 0; i < 6; i++) {
			await n2.step(nodes);
		}

		// Assert
		expect(n2.replicaState.viewNumber).toBeGreaterThan(3);
		const expectedLeaderId = n2.replicaState.viewNumber % nodes.length;
		const expectedLeader = nodes[expectedLeaderId]!;

		const newView = expectedLeader.messageQueue.find(
			(message): message is NewViewMessage => message.type === MessageKind.NewView,
		);
		expect(newView).toBeDefined();
		if (newView) {
			expect(newView.senderId).toBe(n2.id);
			expect(newView.viewNumber).toBe(n2.replicaState.viewNumber);
			expect(newView.lockedQC.nodeHash).toBe("prepared-v3");
		}
	});

	/**
	 * Verifies nextView signaling is emitted once per transition, not repeatedly every tick.
	 * How: trigger a completion-based transition and run extra steps in the same view state;
	 * expected behavior is a single NEW-VIEW message for that transition to avoid network spam.
	 * This is expected to fail until explicit transition bookkeeping is implemented.
	 */
	it("nextView emits one NEW-VIEW per transition", async () => {
		// Arrange
		const config = createTestConfig(3);
		const [replica, nextLeader, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [replica, nextLeader, other] as const;

		replica.replicaState.viewNumber = 6;

		const prepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 6,
			senderId: other.id,
			node: {
				block: {
					hash: "v6-block",
					parentHash: "GENESIS",
					data: { writes: [] },
					height: 1,
				},
				parentHash: "GENESIS",
				justify: createQC("GENESIS", 5, MessageKind.NewView),
			},
		};
		const preCommit: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 6,
			senderId: other.id,
			nodeHash: "v6-block",
			justify: createQC("v6-block", 6, MessageKind.Prepare),
		};
		const commit: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 6,
			senderId: other.id,
			nodeHash: "v6-block",
			justify: createQC("v6-block", 6, MessageKind.PreCommit),
		};
		const decide: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 6,
			senderId: other.id,
			nodeHash: "v6-block",
			justify: createQC("v6-block", 6, MessageKind.Commit),
		};

		replica.message(prepare);
		replica.message(preCommit);
		replica.message(commit);
		replica.message(decide);

		// Act
		await replica.step(nodes);
		await replica.step(nodes);
		await replica.step(nodes);

		// Assert
		const sentNewViews = nextLeader.messageQueue.filter(
			(message): message is NewViewMessage => message.type === MessageKind.NewView,
		);
		expect(sentNewViews).toHaveLength(1);
		if (sentNewViews[0]) {
			expect(sentNewViews[0].viewNumber).toBe(7);
			expect(sentNewViews[0].senderId).toBe(replica.id);
		}
	});
});
