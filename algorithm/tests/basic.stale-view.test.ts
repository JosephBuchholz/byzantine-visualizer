import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import {
	MessageKind,
	type CommitMessage,
	type DecideMessage,
	type PreCommitMessage,
	type PrepareMessage,
	type QuorumCertificate,
} from "../src/types.js";

/** Build deterministic config for stale-view rejection tests. */
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

/** Build deterministic QC fixtures used by phase messages. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff stale-view phase rejection", () => {
	/**
	 * What this test validates:
	 * PREPARE from an older view must be ignored even when it is otherwise structurally valid.
	 *
	 * How it validates it:
	 * 1) Set local replica view to a newer value.
	 * 2) Send a valid PREPARE from the deterministic leader of the older view.
	 * 3) Assert no PREPARE vote is emitted and local prepare/view state does not change.
	 */
	it("ignores stale PREPARE without mutating state or voting", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, staleViewLeader, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, staleViewLeader, n3] as const;

		const follower = n0;
		follower.replicaState.viewNumber = 6;

		const stalePrepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 2,
			senderId: staleViewLeader.id,
			node: {
				block: {
					hash: "stale-prepare-block",
					parentHash: "GENESIS",
					data: { writes: [{ key: "k", value: "v" }] },
					height: 1,
				},
				parentHash: "GENESIS",
				justify: createQC("GENESIS", 1, MessageKind.NewView),
			},
		};

		follower.message(stalePrepare);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.viewNumber).toBe(6);
		expect(follower.replicaState.prepareQC).toBeNull();
		expect(staleViewLeader.messageQueue.length).toBe(0);
	});

	/**
	 * What this test validates:
	 * PRE-COMMIT from an older view must be ignored before updating prepareQC.
	 *
	 * How it validates it:
	 * 1) Pin follower at a newer local view.
	 * 2) Deliver a QC-consistent PRE-COMMIT from the stale view's deterministic leader.
	 * 3) Assert prepareQC remains unchanged and no PRE-COMMIT vote is sent.
	 */
	it("ignores stale PRE-COMMIT without mutating prepareQC or voting", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, staleViewLeader, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, staleViewLeader, n3] as const;

		const follower = n0;
		follower.replicaState.viewNumber = 7;
		const baselinePrepareQC = createQC("fresh-prepare", 7, MessageKind.Prepare);
		follower.replicaState.prepareQC = baselinePrepareQC;

		const stalePreCommit: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 2,
			senderId: staleViewLeader.id,
			nodeHash: "stale-precommit-block",
			justify: createQC("stale-precommit-block", 2, MessageKind.Prepare),
		};

		follower.message(stalePreCommit);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.viewNumber).toBe(7);
		expect(follower.replicaState.prepareQC).toEqual(baselinePrepareQC);
		expect(staleViewLeader.messageQueue.length).toBe(0);
	});

	/**
	 * What this test validates:
	 * COMMIT from an older view must be ignored before updating lockedQC.
	 *
	 * How it validates it:
	 * 1) Start follower with a newer lock in a newer local view.
	 * 2) Deliver a valid stale-view COMMIT from that stale view's leader.
	 * 3) Assert lock remains on the newer QC and no COMMIT vote is emitted.
	 */
	it("ignores stale COMMIT without mutating lockedQC or voting", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, staleViewLeader, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, staleViewLeader, n3] as const;

		const follower = n0;
		follower.replicaState.viewNumber = 8;
		const baselineLock = createQC("fresh-lock", 8, MessageKind.PreCommit);
		follower.replicaState.lockedQC = baselineLock;

		const staleCommit: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 2,
			senderId: staleViewLeader.id,
			nodeHash: "stale-commit-block",
			justify: createQC("stale-commit-block", 2, MessageKind.PreCommit),
		};

		follower.message(staleCommit);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.viewNumber).toBe(8);
		expect(follower.replicaState.lockedQC).toEqual(baselineLock);
		expect(staleViewLeader.messageQueue.length).toBe(0);
	});

	/**
	 * What this test validates:
	 * DECIDE from an older view must be ignored before execution and view transition.
	 *
	 * How it validates it:
	 * 1) Seed follower with a known block that would execute successfully if accepted.
	 * 2) Keep follower in a newer local view, then send a stale-view DECIDE from stale leader.
	 * 3) Assert no execution, no committed block append, and no view bump occurs.
	 */
	it("ignores stale DECIDE without execution, commit append, or view transition", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [n0, n1, staleViewLeader, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, staleViewLeader, n3] as const;

		const follower = n0;
		follower.replicaState.viewNumber = 9;
		follower.knownBlocksByHash.set("stale-decide-block", {
			hash: "stale-decide-block",
			parentHash: "GENESIS",
			data: { writes: [{ key: "stale-decide-key", value: "value" }] },
			height: 1,
		});

		const staleDecide: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 2,
			senderId: staleViewLeader.id,
			nodeHash: "stale-decide-block",
			justify: createQC("stale-decide-block", 2, MessageKind.Commit),
		};

		follower.message(staleDecide);

		// Act
		await follower.step(nodes);

		// Assert
		expect(follower.replicaState.viewNumber).toBe(9);
		expect(follower.replicaState.committedBlocks).toHaveLength(0);
		expect(await follower.read("stale-decide-key")).toBeNull();
	});
});