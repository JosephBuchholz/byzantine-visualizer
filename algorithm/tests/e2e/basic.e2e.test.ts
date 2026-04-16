import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../../src/index.js";
import BasicHotStuffNode from "../../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../../src/data/store.js";
import {
	MessageKind,
	type CommitMessage,
	type DecideMessage,
	type NewViewMessage,
	type PreCommitMessage,
	type PrepareMessage,
	type QuorumCertificate,
} from "../../src/types.js";

/** Build a deterministic config for end-to-end protocol scenarios. */
function createTestConfig(numNodes = 3): Required<HotStuffConfig> {
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

/** Seed leader-only internals to allow deterministic step-by-step orchestration in tests. */
function setLeaderState(node: BasicHotStuffNode) {
	node.leaderState = {
		...node.replicaState,
		pendingVotes: new Map(),
		collectedNewViews: [],
	};
}

/** Build deterministic QC fixtures for scenario setup. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff End-to-End Scenarios", () => {
	/**
	 * End-to-end lifecycle test for a client operation promise.
	 * How: submit a write, verify the returned promise is pending before consensus finishes,
	 * then drive one full 4-phase round and verify the same promise resolves after DECIDE.
	 */
	it("operation promise is pending first and resolves after DECIDE execution", async () => {
		// Arrange
		const config = createTestConfig(3);
		const [leader, followerA, followerB] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, followerA, followerB] as const;
		setLeaderState(leader);

		let settled = false;
		const completionPromise = leader.put("lifecycle-key", "lifecycle-value").then(() => {
			settled = true;
		});

		// Let microtasks flush, then verify the operation is still pending pre-DECIDE.
		await Promise.resolve();
		expect(settled).toBe(false);

		// Act: drive one full Basic HotStuff round to DECIDE.
		await leader.step(nodes);

		await followerA.step(nodes);
		await followerB.step(nodes);
		await leader.step(nodes);

		await followerA.step(nodes);
		await followerB.step(nodes);
		await leader.step(nodes);

		await followerA.step(nodes);
		await followerB.step(nodes);
		await leader.step(nodes);

		await followerA.step(nodes);
		await followerB.step(nodes);
		await completionPromise;

		// Assert: promise resolves only once operation is committed/executed.
		expect(settled).toBe(true);
		expect(await leader.read("lifecycle-key")).toBe("lifecycle-value");
		expect(await followerA.read("lifecycle-key")).toBe("lifecycle-value");
		expect(await followerB.read("lifecycle-key")).toBe("lifecycle-value");
	});

	/**
	 * End-to-end happy path for one full Basic HotStuff view.
	 * How: drive all replicas through PREPARE -> PRE-COMMIT -> COMMIT -> DECIDE with step-by-step
	 * message passing, then assert all replicas executed the decided write and finalized one block.
	 */
	it("normal 4-phase commit reaches decide and executes on all replicas", async () => {
		// Arrange
		const config = createTestConfig(3);
		const [leader, followerA, followerB] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, followerA, followerB] as const;
		setLeaderState(leader);

		void leader.put("e2e-key", "e2e-value");

		// Act
		await leader.step(nodes);

		await followerA.step(nodes);
		await followerB.step(nodes);
		await leader.step(nodes);

		await followerA.step(nodes);
		await followerB.step(nodes);
		await leader.step(nodes);

		await followerA.step(nodes);
		await followerB.step(nodes);
		await leader.step(nodes);

		await followerA.step(nodes);
		await followerB.step(nodes);

		// Assert
		expect(await leader.read("e2e-key")).toBe("e2e-value");
		expect(await followerA.read("e2e-key")).toBe("e2e-value");
		expect(await followerB.read("e2e-key")).toBe("e2e-value");

		expect(leader.replicaState.committedBlocks.length).toBe(1);
		expect(followerA.replicaState.committedBlocks.length).toBe(1);
		expect(followerB.replicaState.committedBlocks.length).toBe(1);
	});

	/**
	 * View-change and liveness-recovery scenario under a slow/faulty leader.
	 * How: keep view-0 leader inactive and only step non-leaders; correct Basic HotStuff behavior
	 * should trigger timeout-driven nextView, NEW-VIEW messages to view-1 leader, then progress.
	 * This guards against regressions in timeout + NEW-VIEW recovery behavior.
	 */
	it("view-change under faulty leader recovers progress in next view", async () => {
		// Arrange
		const config = {
			...createTestConfig(4),
			leaderTimeoutMaxMs: 1,
		};
		const nodes = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];

		const faultyLeader = nodes[0]!;
		const nextLeader = nodes[1]!;
		nextLeader.replicaState.viewNumber = 1;
		setLeaderState(nextLeader);

		// Model client broadcast semantics by submitting the same command to multiple correct replicas.
		// This avoids relying on repeated follower re-forwarding to a faulty leader.
		void nodes[1]!.put("recover-key", "recover-value");
		void nodes[2]!.put("recover-key", "recover-value");
		await nodes[2]!.step(nodes);

		let observedNewViewAtNextLeader = false;
		for (let i = 0; i < 12; i++) {
			await nodes[1]!.step(nodes);
			await nodes[2]!.step(nodes);
			await nodes[3]!.step(nodes);

			observedNewViewAtNextLeader ||= Boolean(
				nextLeader.leaderState?.collectedNewViews.some(
					(message) => message.type === MessageKind.NewView && message.viewNumber > 0,
				),
			);

			if ((await nodes[1]!.read("recover-key")) === "recover-value") {
				break;
			}
		}

		// Assert
		expect(faultyLeader.replicaState.viewNumber).toBe(0);
		expect(nodes[2]!.replicaState.viewNumber).toBeGreaterThan(0);
		expect(nodes[3]!.replicaState.viewNumber).toBeGreaterThan(0);

		expect(observedNewViewAtNextLeader).toBe(true);

		expect(await nodes[1]!.read("recover-key")).toBe("recover-value");
	});

	/**
	 * highQC carry-over and stale-lock recovery across views.
	 * How: provide a new leader with multiple NEW-VIEW messages carrying different QCs and include a
	 * replica that is locked on an older QC; the leader should choose highest QC, propose from it,
	 * and the stale-locked replica should recover by accepting the higher-justify proposal.
	 * This guards against regressions in NEW-VIEW highQC carry-over behavior.
	 */
	it("highQC carry-over enables stale-lock recovery across views", async () => {
		// Arrange
		const config = createTestConfig(4);
		const [oldLeader, newLeader, replicaA, staleLockedReplica] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [oldLeader, newLeader, replicaA, staleLockedReplica] as const;
		setLeaderState(newLeader);

		newLeader.replicaState.viewNumber = 1;
		newLeader.leaderState!.viewNumber = 1;
		replicaA.replicaState.viewNumber = 1;
		staleLockedReplica.replicaState.viewNumber = 1;

		const oldLockQC = createQC("old-locked-block", 2, MessageKind.PreCommit);
		const highPrepareQC = createQC("high-qc-block", 5, MessageKind.Prepare);
		staleLockedReplica.replicaState.lockedQC = oldLockQC;

		const newViewFromLeader: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: newLeader.id,
			prepareQC: oldLockQC,
			partialSig: "nv-sig-1",
		};
		const newViewFromReplicaA: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: replicaA.id,
			prepareQC: highPrepareQC,
			partialSig: "nv-sig-2",
		};
		const newViewFromStaleReplica: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: 1,
			senderId: staleLockedReplica.id,
			prepareQC: oldLockQC,
			partialSig: "nv-sig-3",
		};

		newLeader.message(newViewFromLeader);
		newLeader.message(newViewFromReplicaA);
		newLeader.message(newViewFromStaleReplica);
		void newLeader.put("carry-over-key", "carry-over-value");

		// Act
		await newLeader.step(nodes);

		// Assert
		expect(staleLockedReplica.messageQueue.length).toBeGreaterThan(0);
		const prepareToStale = staleLockedReplica.messageQueue.find(
			(message) => message.type === MessageKind.Prepare,
		);
		expect(prepareToStale).toBeDefined();

		if (prepareToStale?.type === MessageKind.Prepare) {
			expect(prepareToStale.node.justify.nodeHash).toBe(highPrepareQC.nodeHash);
			expect(prepareToStale.node.justify.viewNumber).toBe(highPrepareQC.viewNumber);
		}
	});

	/**
	 * Repeated DECIDE idempotency.
	 * How: deliver the same DECIDE twice for the same block and assert the second delivery does not
	 * cause extra effects. Idempotency means applying the same operation repeatedly yields the same
	 * resulting state as applying it once.
	 * This guards against regressions in duplicate DECIDE idempotency handling.
	 */
	it("repeated DECIDE is idempotent", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, follower, other] as const;

		const nodeHash = "idempotent-block";
		const prepareMessage: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 9,
			senderId: leader.id,
			node: {
				block: {
					hash: nodeHash,
					parentHash: "GENESIS",
					data: { writes: [{ key: "idempotent-key", value: "value" }] },
					height: 1,
				},
				parentHash: "GENESIS",
				justify: createQC("GENESIS", 8, MessageKind.NewView),
			},
		};

		const preCommitMessage: PreCommitMessage = {
			type: MessageKind.PreCommit,
			viewNumber: 9,
			senderId: leader.id,
			nodeHash,
			justify: createQC(nodeHash, 9, MessageKind.Prepare),
		};

		const commitMessage: CommitMessage = {
			type: MessageKind.Commit,
			viewNumber: 9,
			senderId: leader.id,
			nodeHash,
			justify: createQC(nodeHash, 9, MessageKind.PreCommit),
		};

		const decideMessage: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 9,
			senderId: leader.id,
			nodeHash,
			justify: createQC(nodeHash, 9, MessageKind.Commit),
		};

		follower.message(prepareMessage);
		follower.message(preCommitMessage);
		follower.message(commitMessage);
		follower.message(decideMessage);
		follower.message(decideMessage);

		// Act
		await follower.step(nodes);

		// Assert
		expect(
			follower.replicaState.committedBlocks.filter((block) => block.hash === nodeHash),
		).toHaveLength(1);
		expect(await follower.read("idempotent-key")).toBe("value");
		expect(follower.replicaState.viewNumber).toBe(10);
	});
});
