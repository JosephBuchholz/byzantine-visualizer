import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";
import { MessageKind, type DecideMessage, type QuorumCertificate } from "../src/types.js";

/** Build deterministic config so execution-path assertions are stable and reproducible. */
function createTestConfig(): Required<HotStuffConfig> {
	return {
		numNodes: 3,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 100,
		maxBatchSize: 10,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
	};
}

/** Helper for creating isolated nodes with in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/** Build deterministic QC fixtures used by DECIDE test messages. */
function createQC(nodeHash: string, viewNumber: number, type: MessageKind): QuorumCertificate {
	return {
		type,
		viewNumber,
		nodeHash,
		thresholdSig: `qc-${type}-${viewNumber}-${nodeHash}`,
	};
}

describe("Basic HotStuff committed-branch execution semantics", () => {
	/**
	 * Verifies operation promises stay pending when DECIDE is stale and therefore rejected.
	 * How: submit a write operation, move local view ahead, deliver a stale DECIDE that would
	 * otherwise execute that write, and assert the promise does not resolve.
	 */
	it("operation promise does not resolve when DECIDE is stale", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		let settled = false;
		void follower.put("stale-op-key", "stale-op-value").then(() => {
			settled = true;
		});

		follower.knownBlocksByHash.set("stale-op-block", {
			hash: "stale-op-block",
			parentHash: "GENESIS",
			data: { writes: [{ key: "stale-op-key", value: "stale-op-value" }] },
			height: 1,
		});

		// Raise local view so the incoming DECIDE is considered stale and rejected.
		follower.replicaState.viewNumber = 10;

		const staleDecide: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 2,
			// In n=3, view 2 leader is node 2, so sender is leader-authentic but stale.
			senderId: other.id,
			nodeHash: "stale-op-block",
			justify: createQC("stale-op-block", 2, MessageKind.Commit),
		};

		// Let the operation promise settle if it would resolve immediately (it should not).
		await Promise.resolve();
		expect(settled).toBe(false);

		follower.message(staleDecide);

		// Act
		await follower.step([leader, follower, other]);

		// Assert: stale DECIDE does not execute or resolve operation lifecycle.
		expect(settled).toBe(false);
		expect(await follower.read("stale-op-key")).toBeNull();
		expect(follower.replicaState.committedBlocks).toHaveLength(0);
	});

	/**
	 * Verifies operation promises stay pending when DECIDE is rejected as malformed.
	 * How: submit a write operation, deliver DECIDE whose QC certifies a different node hash,
	 * and assert no execution and no operation-promise resolution occurs.
	 */
	it("operation promise does not resolve when DECIDE is rejected (QC mismatch)", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		let settled = false;
		void follower.put("reject-op-key", "reject-op-value").then(() => {
			settled = true;
		});

		follower.knownBlocksByHash.set("reject-op-block", {
			hash: "reject-op-block",
			parentHash: "GENESIS",
			data: { writes: [{ key: "reject-op-key", value: "reject-op-value" }] },
			height: 1,
		});

		const malformedDecide: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 0,
			senderId: leader.id,
			nodeHash: "reject-op-block",
			justify: createQC("different-block", 0, MessageKind.Commit),
		};

		// Let the operation promise settle if it would resolve immediately (it should not).
		await Promise.resolve();
		expect(settled).toBe(false);

		follower.message(malformedDecide);

		// Act
		await follower.step([leader, follower, other]);

		// Assert: malformed DECIDE does not execute or resolve operation lifecycle.
		expect(settled).toBe(false);
		expect(await follower.read("reject-op-key")).toBeNull();
		expect(follower.replicaState.committedBlocks).toHaveLength(0);
	});

	/**
	 * Verifies DECIDE executes the full unexecuted branch, not only the tip block.
	 * How: build a three-block chain A -> B -> C with distinct writes on each block and DECIDE C.
	 * Expected behavior is that all three writes become visible and all three blocks are recorded
	 * as executed/committed in branch order from ancestor to tip.
	 * This guards against regressions in branch-from-last-executed semantics.
	 */
	it("DECIDE executes entire ancestor-to-tip branch on first commit", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		follower.knownBlocksByHash.set("A", {
			hash: "A",
			parentHash: "GENESIS",
			data: { writes: [{ key: "kA", value: "vA" }] },
			height: 1,
		});
		follower.knownBlocksByHash.set("B", {
			hash: "B",
			parentHash: "A",
			data: { writes: [{ key: "kB", value: "vB" }] },
			height: 2,
		});
		follower.knownBlocksByHash.set("C", {
			hash: "C",
			parentHash: "B",
			data: { writes: [{ key: "kC", value: "vC" }] },
			height: 3,
		});

		const decideC: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 20,
			// In n=3, view 20 leader is node 2.
			senderId: other.id,
			nodeHash: "C",
			justify: createQC("C", 20, MessageKind.Commit),
		};
		// Seed prior COMMIT acceptance so this test isolates DECIDE branch execution behavior.
		follower.acceptedCommitByView.set(20, new Set(["C"]));

		follower.message(decideC);

		// Act
		await follower.step([leader, follower, other]);

		// Assert
		expect(await follower.read("kA")).toBe("vA");
		expect(await follower.read("kB")).toBe("vB");
		expect(await follower.read("kC")).toBe("vC");
		expect(follower.replicaState.committedBlocks.map((block) => block.hash)).toEqual([
			"A",
			"B",
			"C",
		]);
	});

	/**
	 * Verifies execution progresses from last-executed block instead of re-running the whole chain.
	 * How: pre-mark A and B as already committed/executed, then DECIDE D on A -> B -> C -> D.
	 * Expected behavior is that only C and D are newly executed and appended to committed history.
	 * This guards against regressions in last-executed suffix tracking.
	 */
	it("DECIDE executes only the unexecuted suffix beyond last executed block", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		const blockA = {
			hash: "A",
			parentHash: "GENESIS",
			data: { writes: [{ key: "kA", value: "vA" }] },
			height: 1,
		};
		const blockB = {
			hash: "B",
			parentHash: "A",
			data: { writes: [{ key: "kB", value: "vB" }] },
			height: 2,
		};
		const blockC = {
			hash: "C",
			parentHash: "B",
			data: { writes: [{ key: "kC", value: "vC" }] },
			height: 3,
		};
		const blockD = {
			hash: "D",
			parentHash: "C",
			data: { writes: [{ key: "kD", value: "vD" }] },
			height: 4,
		};

		follower.knownBlocksByHash.set("A", blockA);
		follower.knownBlocksByHash.set("B", blockB);
		follower.knownBlocksByHash.set("C", blockC);
		follower.knownBlocksByHash.set("D", blockD);

		follower.replicaState.committedBlocks.push(blockA, blockB);
		await follower.dataStore.put("kA", "vA");
		await follower.dataStore.put("kB", "vB");

		const decideD: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 21,
			senderId: leader.id,
			nodeHash: "D",
			justify: createQC("D", 21, MessageKind.Commit),
		};
		// Seed prior COMMIT acceptance so this test isolates DECIDE suffix execution behavior.
		follower.acceptedCommitByView.set(21, new Set(["D"]));

		follower.message(decideD);

		// Act
		await follower.step([leader, follower, other]);

		// Assert
		expect(await follower.read("kA")).toBe("vA");
		expect(await follower.read("kB")).toBe("vB");
		expect(await follower.read("kC")).toBe("vC");
		expect(await follower.read("kD")).toBe("vD");
		expect(follower.replicaState.committedBlocks.map((block) => block.hash)).toEqual([
			"A",
			"B",
			"C",
			"D",
		]);
	});

	/**
	 * Verifies DECIDE does not partially execute when branch ancestry is incomplete.
	 * How: provide only tip block C while its parent chain is missing from local tree, then DECIDE C.
	 * Expected behavior is rejection (or no execution), since branch-from-last-executed cannot be
	 * deterministically reconstructed; this prevents state divergence from partial branch execution.
	 * This guards against regressions in full branch reconstruction checks.
	 */
	it("DECIDE does not execute tip when ancestor chain is missing", async () => {
		// Arrange
		const config = createTestConfig();
		const [leader, follower, other] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];

		follower.knownBlocksByHash.set("C", {
			hash: "C",
			parentHash: "B",
			data: { writes: [{ key: "kC", value: "vC" }] },
			height: 3,
		});

		const decideC: DecideMessage = {
			type: MessageKind.Decide,
			viewNumber: 22,
			senderId: leader.id,
			nodeHash: "C",
			justify: createQC("C", 22, MessageKind.Commit),
		};

		follower.message(decideC);

		// Act
		await follower.step([leader, follower, other]);

		// Assert
		expect(await follower.read("kC")).toBeNull();
		expect(follower.replicaState.committedBlocks).toHaveLength(0);
	});
});
