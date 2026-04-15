import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import {
	MessageKind,
	type NewViewMessage,
	type PrepareMessage,
	type QuorumCertificate,
} from "../src/types.js";

/** Build deterministic config for network-path educational scenarios. */
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

/** Helper to create isolated nodes with fresh in-memory state. */
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

/**
 * Drop cross-partition messages from each node queue.
 * How: keep only messages whose sender belongs to the same partition as the receiver.
 */
function dropCrossPartitionMessages(
	nodes: readonly BasicHotStuffNode[],
	partitionA: Set<number>,
	partitionB: Set<number>,
): void {
	for (const receiver of nodes) {
		const receiverInA = partitionA.has(receiver.id);
		receiver.messageQueue = receiver.messageQueue.filter((message) => {
			const senderInA = partitionA.has(message.senderId);
			if (receiverInA) {
				return senderInA;
			}
			return partitionB.has(message.senderId);
		});
	}
}

describe("Basic HotStuff explicit network-path scenarios", () => {
	/**
	 * Path 3D — leader partial broadcast to a subset.
	 *
	 * What this test demonstrates:
	 * A leader sends PREPARE to only a subset of replicas. Receivers may vote, but quorum is not
	 * reached, so no later phase can complete and the system eventually leaves the view via timeout.
	 *
	 * How it demonstrates it:
	 * 1) Deliver one valid PREPARE to only one follower in view 2.
	 * 2) Process follower and leader steps (leader collects at most a partial vote set).
	 * 3) Assert no PRE-COMMIT broadcast appears and no commits occur.
	 * 4) Continue stepping until timeout transitions begin, proving automatic recovery path.
	 */
	it("Path 3D: partial broadcast cannot reach quorum and falls back to timeout/view-change", async () => {
		// Arrange
		const config = createTestConfig({ leaderTimeoutMaxMs: 1 });
		const [followerA, followerB, leaderV2, followerC] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [followerA, followerB, leaderV2, followerC] as const;

		// Put all replicas in the same target view for deterministic leader/auth checks.
		for (const node of nodes) {
			node.replicaState.viewNumber = 2;
		}

		const partialPrepare: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: 2,
			senderId: leaderV2.id,
			node: {
				block: {
					hash: "path3d-subset-node",
					parentHash: "GENESIS",
					data: { writes: [{ key: "path3d", value: "value" }] },
					height: 1,
				},
				parentHash: "GENESIS",
				justify: createQC("GENESIS", 1, MessageKind.NewView),
			},
		};

		// Partial broadcast: only one follower receives the PREPARE.
		followerA.message(partialPrepare);

		// Act
		await followerA.step(nodes);
		await leaderV2.step(nodes);

		// Assert intermediate state: no PRE-COMMIT fanout because quorum cannot be reached.
		const preCommitSeenOutsideSubset =
			followerB.messageQueue.some((message) => message.type === MessageKind.PreCommit) ||
			followerC.messageQueue.some((message) => message.type === MessageKind.PreCommit);
		expect(preCommitSeenOutsideSubset).toBe(false);

		// Continue stepping to let timeout-driven view transitions occur.
		for (let i = 0; i < 6; i += 1) {
			for (const node of nodes) {
				await node.step(nodes);
			}
		}

		// Liveness in this view fails; safety preserved (no commits).
		expect(nodes.every((node) => node.replicaState.committedBlocks.length === 0)).toBe(true);
		expect(Math.max(...nodes.map((node) => node.replicaState.viewNumber))).toBeGreaterThan(2);
	});

	/**
	 * Path 5 — pre-GST asynchronous partition.
	 *
	 * What this test demonstrates:
	 * With all replicas alive but network partitioned into two islands smaller than quorum,
	 * safety is preserved (no commits) while liveness stalls and views keep changing.
	 *
	 * How it demonstrates it:
	 * 1) Split the cluster into partitions {0,1} and {2,3}.
	 * 2) On every round, drop all cross-partition messages before and after stepping.
	 * 3) Inject a client write so the protocol actively attempts progress.
	 * 4) Assert no replica commits while views still advance due timeout/backoff behavior.
	 */
	it("Path 5: pre-GST partition preserves safety but prevents liveness", async () => {
		// Arrange
		const config = createTestConfig({ leaderTimeoutMaxMs: 1, maxBatchSize: 1 });
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		const partitionA = new Set<number>([0, 1]);
		const partitionB = new Set<number>([2, 3]);

		// Add pending work so replicas keep attempting consensus under partitioned transport.
		void n0.put("path5-key", "path5-value");

		// Act
		for (let round = 0; round < 12; round += 1) {
			dropCrossPartitionMessages(nodes, partitionA, partitionB);
			for (const node of nodes) {
				await node.step(nodes);
			}
			dropCrossPartitionMessages(nodes, partitionA, partitionB);
		}

		// Assert
		// Safety: no commits under partition pressure.
		expect(nodes.every((node) => node.replicaState.committedBlocks.length === 0)).toBe(true);
		// Liveness pre-GST is not guaranteed: nodes keep moving views via timeout.
		expect(Math.max(...nodes.map((node) => node.replicaState.viewNumber))).toBeGreaterThan(0);
	});

	/**
	 * Path 5 (recovery extension) — partition heals and progress resumes.
	 *
	 * What this test demonstrates:
	 * Liveness can be unavailable while a pre-GST partition exists, but once connectivity is restored
	 * (GST-like healing), Basic HotStuff eventually regains progress and commits consistently.
	 *
	 * How it demonstrates it:
	 * 1) Start with the same 2+2 partition used by Path 5 and keep dropping cross-partition messages.
	 * 2) Verify no commits occur during the partitioned rounds.
	 * 3) Stop dropping cross-partition messages (healed network) and keep stepping all nodes.
	 * 4) Assert all replicas eventually commit the client write and converge on the same tip hash.
	 */
	it("Path 5 recovery: after GST-like healing, replicas eventually make progress and converge", async () => {
		// Arrange
		const config = createTestConfig({ leaderTimeoutMaxMs: 1, maxBatchSize: 1 });
		const [n0, n1, n2, n3] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
			createTestNode(3, config),
		];
		const nodes = [n0, n1, n2, n3] as const;

		const partitionA = new Set<number>([0, 1]);
		const partitionB = new Set<number>([2, 3]);

		void n0.put("path5-heal-key", "path5-heal-value");

		// Act (phase 1: partitioned transport, pre-GST style)
		for (let round = 0; round < 12; round += 1) {
			dropCrossPartitionMessages(nodes, partitionA, partitionB);
			for (const node of nodes) {
				await node.step(nodes);
			}
			dropCrossPartitionMessages(nodes, partitionA, partitionB);
		}

		// Assert pre-heal state: safety preserved, liveness stalled.
		expect(nodes.every((node) => node.replicaState.committedBlocks.length === 0)).toBe(true);

		// Model GST-like stabilization explicitly:
		// 1) Align all replicas to one common view window so deterministic leadership matches.
		// 2) Deliver one NEW-VIEW message per replica to the healed view leader.
		// This avoids indefinite skew from pre-GST timing artifacts and focuses this scenario on
		// post-heal eventual progress rather than view-alignment mechanics.
		const healedView = Math.max(...nodes.map((node) => node.replicaState.viewNumber)) + 1;
		for (const node of nodes) {
			node.replicaState.viewNumber = healedView;
		}

		const healedLeader = nodes[healedView % nodes.length]!;
		for (const sender of nodes) {
			const carriedPrepareQC = sender.replicaState.prepareQC ?? createQC("GENESIS", 0, MessageKind.NewView);
			const newView: NewViewMessage = {
				type: MessageKind.NewView,
				viewNumber: healedView,
				senderId: sender.id,
				prepareQC: carriedPrepareQC,
				partialSig: `heal-nv-${sender.id}-${healedView}`,
			};
			healedLeader.message(newView);
		}

		// Act (phase 2: healed transport, GST-like period with bounded delay)
		let convergedCommit = false;
		for (let round = 0; round < 80; round += 1) {
			for (const node of nodes) {
				await node.step(nodes);
			}

			convergedCommit = nodes.every((node) => node.replicaState.committedBlocks.length > 0);
			if (convergedCommit) {
				break;
			}
		}

		// Assert post-heal state: eventual progress and convergence.
		expect(convergedCommit).toBe(true);
		for (const node of nodes) {
			expect(await node.read("path5-heal-key")).toBe("path5-heal-value");
		}

		const committedTipHashes = new Set(
			nodes.map((node) => node.replicaState.committedBlocks.at(-1)?.hash),
		);
		expect(committedTipHashes.size).toBe(1);
	});
});
