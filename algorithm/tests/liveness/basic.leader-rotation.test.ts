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

/** Build deterministic config for leader-rotation TDD scenarios. */
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

/** Helper to create isolated nodes with fresh in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/**
 * Seed leader-only internals to mirror run-loop startup behavior at view 0.
 * This helper is intentionally used only for the genesis leader so tests can
 * verify whether later leaders are promoted automatically.
 */
function setLeaderState(node: BasicHotStuffNode) {
	node.leaderState = {
		...node.replicaState,
		pendingVotes: new Map(),
		collectedNewViews: [],
	};
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

describe("Basic HotStuff runtime leader rotation", () => {
	/**
	 * TDD red test: when a node's local view indicates it is the deterministic leader,
	 * stepping the node should promote it into leader mode without manual test seeding.
	 *
	 * Why this matters: view leadership rotates every view in Basic HotStuff. If runtime
	 * promotion is missing, the elected leader may never become operational.
	 */
	it("promotes deterministic leader at runtime without manual leader-state seeding", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		// Move all replicas to view 1 where node 1 is deterministic leader.
		n0.replicaState.viewNumber = 1;
		n1.replicaState.viewNumber = 1;
		n2.replicaState.viewNumber = 1;
		n3.replicaState.viewNumber = 1;

		expect(n1.findLeader(nodes).id).toBe(1);
		expect(n1.leaderState).toBeNull();

		// Act
		await n1.step(nodes);

		// Assert
		expect(n1.leaderState).not.toBeNull();
	});

	/**
	 * TDD red test: after transitioning from view 0 to view 1, old leader (node 0)
	 * must demote to follower behavior and forward client writes to new leader (node 1).
	 *
	 * Why this matters: if old leader keeps leader role after view change, the protocol
	 * can stall or show incorrect leadership in the visualization.
	 */
	it("demotes old leader after view change and forwards writes to the new leader", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		// Mirror startup where node 0 is the genesis leader.
		setLeaderState(n0);
		expect(n0.findLeader(nodes).id).toBe(0);

		// Drive node 0 through a valid local decision to transition into view 1.
		const prepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 0,
			senderId: n0.id,
			node: {
				block: {
					hash: "v0-block",
					parentHash: "GENESIS",
					data: { writes: [] },
					height: 1,
				},
				parentHash: "GENESIS",
				justify: createQC("GENESIS", 0, MessageKind.NewView),
			},
		};
		const preCommit: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 0,
			senderId: n0.id,
			nodeHash: "v0-block",
			justify: createQC("v0-block", 0, MessageKind.Prepare),
		};
		const commit: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 0,
			senderId: n0.id,
			nodeHash: "v0-block",
			justify: createQC("v0-block", 0, MessageKind.PreCommit),
		};
		const decide: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 0,
			senderId: n0.id,
			nodeHash: "v0-block",
			justify: createQC("v0-block", 0, MessageKind.Commit),
		};

		n0.message(prepare);
		n0.message(preCommit);
		n0.message(commit);
		n0.message(decide);
		await n0.step(nodes);

		expect(n0.replicaState.viewNumber).toBe(1);
		expect(n0.findLeader(nodes).id).toBe(1);

		// Act: old leader receives client write in view 1.
		void n0.put("handoff-key", "handoff-value");
		await n0.step(nodes);

		// Assert: write is forwarded to new leader instead of being retained by old leader.
		expect(n0.pendingWrites.has("handoff-key")).toBe(false);
		expect(n1.pendingWrites.get("handoff-key")).toBe("handoff-value");
	});
});
