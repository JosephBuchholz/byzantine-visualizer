import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";

/**
 * Build deterministic config fixtures for system-model validation tests.
 */
function createTestConfig(numNodes: number): Required<HotStuffConfig> {
	return {
		numNodes,
		loopTimeoutMaxMs: 10,
		leaderTimeoutMaxMs: 10,
		maxBatchSize: 1,
		maxBatchWaitTimeMs: 10,
		logger: () => {},
	};
}

/**
 * Helper to create one node with fresh in-memory state.
 */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/**
 * Create a full node set where ids are 0..numNodes-1.
 */
function createNodeSet(numNodes: number): BasicHotStuffNode[] {
	const config = createTestConfig(numNodes);
	return Array.from({ length: numNodes }, (_, id) => createTestNode(id, config));
}

/**
 * Run one node with a short deadline.
 *
 * Why this helper exists:
 * - For invalid model sizes, we expect run() to fail fast with an error result.
 * - For current behavior (pre-fix), run() may keep looping, so this helper detects
 *   missing fast-fail behavior without hanging the test process.
 */
async function runWithDeadline(
	node: BasicHotStuffNode,
	nodes: BasicHotStuffNode[],
	deadlineMs = 75,
): Promise<Awaited<ReturnType<BasicHotStuffNode["run"]>> | "timeout"> {
	return Promise.race([
		node.run(nodes),
		new Promise<"timeout">((resolve) => {
			setTimeout(() => resolve("timeout"), deadlineMs);
		}),
	]);
}

describe("Basic HotStuff system-model preconditions (TDD)", () => {
	/**
	 * What: invalid replica sizes that do not satisfy n = 3f + 1 should be rejected.
	 * How: for each invalid n (2, 3, 5, 6), run one node against a matching cluster and
	 * assert run() returns an error before the deadline instead of entering the main loop.
	 *
	 * This is a red test for the current behavior where arbitrary n values are accepted.
	 */
	it("fails fast when numNodes violates n = 3f + 1", async () => {
		const invalidSizes = [2, 3, 5, 6];

		for (const n of invalidSizes) {
			const nodes = createNodeSet(n);
			const runner = nodes[0]!;

			const result = await runWithDeadline(runner, nodes);

			expect(result).not.toBe("timeout");
			if (result !== "timeout") {
				expect(result.isErr()).toBe(true);
			}

			// Cleanup only when the timeout path occurred, which indicates the run loop
			// is likely still active and needs an explicit abort signal.
			if (result === "timeout") {
				await runner.abort().catch(() => {});
			}
		}
	});

	/**
	 * What: valid model sizes should remain accepted and keep existing run-loop behavior.
	 * How: use valid n values (1, 4, 7), start run(), abort it, and assert the node exits
	 * cleanly rather than failing model validation.
	 *
	 * This protects against over-strict validation that would reject legitimate 3f+1 sizes.
	 */
	it("accepts valid n = 3f + 1 sizes and still runs normally", async () => {
		const validSizes = [1, 4, 7];

		for (const n of validSizes) {
			const nodes = createNodeSet(n);
			const runner = nodes[0]!;

			const runPromise = runner.run(nodes);
			const abortResult = await runner.abort();
			const runResult = await runPromise;

			expect(abortResult.isOk()).toBe(true);
			expect(runResult.isOk()).toBe(true);
		}
	});

	/**
	 * What: existing node-count mismatch guard should still take precedence when cluster
	 * size does not match config.numNodes.
	 * How: configure n=4 but pass only 3 nodes and assert immediate error (fast-fail).
	 *
	 * This prevents regressions where new model validation accidentally weakens existing
	 * startup safety checks.
	 */
	it("preserves fail-fast behavior for config/node-array size mismatch", async () => {
		const config = createTestConfig(4);
		const nodes = [createTestNode(0, config), createTestNode(1, config), createTestNode(2, config)];
		const runner = nodes[0]!;

		const result = await runWithDeadline(runner, nodes);

		expect(result).not.toBe("timeout");
		if (result !== "timeout") {
			expect(result.isErr()).toBe(true);
		}
	});
});
