import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../../src/index.js";
import BasicHotStuffNode from "../../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../../src/data/store.js";
import {
	MessageKind,
	type DecideMessage,
	type PrepareMessage,
	type QuorumCertificate,
	type VoteMessage,
} from "../../src/types.js";

/** Build deterministic config fixtures for failure-mode simulations. */
function createTestConfig(overrides?: Partial<Required<HotStuffConfig>>): Required<HotStuffConfig> {
	return {
		numNodes: 4,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 1,
		maxBatchSize: 1,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
		...overrides,
	};
}

/** Create a node with isolated in-memory storage. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Create deterministic QC fixtures accepted by simulator QC verification. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff explicit failure-mode simulations", () => {
	/**
	 * Path 7 — quorum stall (fault threshold exceeded).
	 *
	 * Scenario: in n=4 (f=1), simulate two crashed replicas (>f unavailable).
	 * Only two nodes run steps, so quorum (2f+1 = 3) is never reachable.
	 * Expected: views keep advancing via timeout, but no commits occur.
	 */
	it("Path 7: quorum stall under over-threshold unavailability", async () => {
		// Arrange
		const config = createTestConfig({ leaderTimeoutMaxMs: 1, maxBatchSize: 1 });
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		// Simulate one client operation so active nodes attempt protocol progress.
		void n0.put("stall-key", "stall-value");

		// Act
		// n2 and n3 are "crashed": we never call step() for them.
		for (let i = 0; i < 10; i += 1) {
			await n0.step(nodes);
			await n1.step(nodes);
		}

		// Assert
		// Liveness is lost (no decisions), but timeout path still advances views.
		expect(n0.replicaState.committedBlocks).toHaveLength(0);
		expect(n1.replicaState.committedBlocks).toHaveLength(0);
		expect(Math.max(n0.replicaState.viewNumber, n1.replicaState.viewNumber)).toBeGreaterThan(0);
	});

	/**
	 * Path 8 — forged QC (fault threshold exceeded, safety violated).
	 *
	 * Scenario: inject two conflicting DECIDE messages with syntactically valid commitQCs
	 * to two different correct replicas, modeling an adversary with enough key control to
	 * forge threshold signatures once assumptions are broken.
	 * Expected: the two correct replicas commit conflicting values.
	 */
	it("Path 8: conflicting forged commitQCs can split correct replicas", async () => {
		// Arrange
		const config = createTestConfig({ leaderTimeoutMaxMs: 100 });
		const [r0, r1, leaderV2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [r0, r1, leaderV2, n3] as const;

		r0.replicaState.viewNumber = 2;
		r1.replicaState.viewNumber = 2;

		const blockA = {
			hash: "forged-branch-A",
			parentHash: "GENESIS",
			data: { writes: [{ key: "x", value: "A" }] },
			height: 1,
		};
		const blockB = {
			hash: "forged-branch-B",
			parentHash: "GENESIS",
			data: { writes: [{ key: "x", value: "B" }] },
			height: 1,
		};
		r0.knownBlocksByHash.set(blockA.hash, blockA);
		r1.knownBlocksByHash.set(blockB.hash, blockB);

		const decideA: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 2,
			senderId: leaderV2.id,
			nodeHash: blockA.hash,
			justify: createQC(blockA.hash, 2, MessageKind.Commit),
		};
		const decideB: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 2,
			senderId: leaderV2.id,
			nodeHash: blockB.hash,
			justify: createQC(blockB.hash, 2, MessageKind.Commit),
		};

		// Seed prior COMMIT acceptance so this test isolates forged-QC safety divergence behavior.
		r0.acceptedCommitByView.set(2, new Set([blockA.hash]));
		r1.acceptedCommitByView.set(2, new Set([blockB.hash]));

		r0.message(decideA);
		r1.message(decideB);

		// Act
		await r0.step(nodes);
		await r1.step(nodes);

		// Assert
		expect(r0.replicaState.committedBlocks.at(-1)?.hash).toBe(blockA.hash);
		expect(r1.replicaState.committedBlocks.at(-1)?.hash).toBe(blockB.hash);
		expect(await r0.read("x")).toBe("A");
		expect(await r1.read("x")).toBe("B");
	});

	/**
	 * Path 9 — quorum intersection breakdown (fault threshold exceeded).
	 *
	 * Scenario: one correct replica is locked on a high-view branch and rejects a conflicting
	 * PREPARE, but a Byzantine leader still forms a PREPARE quorum using one honest vote +
	 * Byzantine votes. This models loss of the "at least one correct in every quorum intersection"
	 * witness once assumptions are exceeded.
	 * Expected: conflicting branch can still advance to PRE-COMMIT despite a correct rejection.
	 */
	it("Path 9: conflicting branch can advance despite one correct locked rejection", async () => {
		// Arrange
		const config = createTestConfig({ leaderTimeoutMaxMs: 100 });
		const [lockedReplica, unlockedReplica, byzantinePeer, byzantineLeader] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [lockedReplica, unlockedReplica, byzantinePeer, byzantineLeader] as const;

		lockedReplica.replicaState.viewNumber = 3;
		unlockedReplica.replicaState.viewNumber = 3;
		byzantineLeader.replicaState.viewNumber = 3;

		// lockedReplica has a high lock on an older branch.
		lockedReplica.replicaState.lockedQC = createQC("locked-high", 10, MessageKind.PreCommit);

		const conflictingBlock = {
			hash: "intersection-breakdown-branch",
			parentHash: "GENESIS",
			data: { writes: [] },
			height: 1,
		};

		const conflictingPrepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 3,
			senderId: byzantineLeader.id,
			node: {
				block: conflictingBlock,
				parentHash: "GENESIS",
				justify: createQC("GENESIS", 1, MessageKind.NewView),
			},
		};

		lockedReplica.message(conflictingPrepare);
		unlockedReplica.message(conflictingPrepare);

		await lockedReplica.step(nodes);
		await unlockedReplica.step(nodes);

		const prepareVotesBeforeByzantineInjection = byzantineLeader.messageQueue.filter(
			(message): message is VoteMessage =>
				message.type === MessageKind.Vote &&
				message.voteType === MessageKind.Prepare &&
				message.nodeHash === conflictingBlock.hash,
		);

		// One honest vote (from unlockedReplica) arrives; lockedReplica rejects.
		expect(prepareVotesBeforeByzantineInjection).toHaveLength(1);
		expect(prepareVotesBeforeByzantineInjection[0]!.senderId).toBe(unlockedReplica.id);

		// Inject Byzantine votes to model >f coordinated faulty replicas.
		byzantineLeader.message({
			type: MessageKind.Vote,
			voteType: MessageKind.Prepare,
			nodeHash: conflictingBlock.hash,
			partialSig: `sig-${byzantinePeer.id}-${conflictingBlock.hash}`,
			viewNumber: 3,
			senderId: byzantinePeer.id,
		});
		byzantineLeader.message({
			type: MessageKind.Vote,
			voteType: MessageKind.Prepare,
			nodeHash: conflictingBlock.hash,
			partialSig: `sig-${byzantineLeader.id}-${conflictingBlock.hash}`,
			viewNumber: 3,
			senderId: byzantineLeader.id,
		});

		// Act
		await byzantineLeader.step(nodes);

		// Assert
		const preCommitForConflictingBranch = unlockedReplica.messageQueue.find(
			(message) =>
				message.type === MessageKind.PreCommit && message.nodeHash === conflictingBlock.hash,
		);
		expect(preCommitForConflictingBranch).toBeDefined();
	});
});
