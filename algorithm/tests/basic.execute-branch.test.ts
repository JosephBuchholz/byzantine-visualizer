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
	 * Verifies DECIDE executes the full unexecuted branch, not only the tip block.
	 * How: build a three-block chain A -> B -> C with distinct writes on each block and DECIDE C.
	 * Expected behavior is that all three writes become visible and all three blocks are recorded
	 * as executed/committed in branch order from ancestor to tip.
	 * This is expected to fail until branch-from-last-executed semantics are implemented.
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
			senderId: leader.id,
			nodeHash: "C",
			justify: createQC("C", 20, MessageKind.Commit),
		};

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
	 * This is expected to fail until last-executed tracking is implemented.
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
	 * This is expected to fail until full branch reconstruction checks are implemented.
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
