import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";

/** Build deterministic config for follower-forwarding behavior tests. */
function createTestConfig(numNodes = 3): Required<HotStuffConfig> {
	return {
		numNodes,
		loopTimeoutMaxMs: 100,
		leaderTimeoutMaxMs: 100,
		maxBatchSize: 10,
		maxBatchWaitTimeMs: 100,
		logger: () => {},
	};
}

/** Helper to create a node with fresh in-memory state per test case. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

describe("Basic HotStuff follower forwarding semantics", () => {
	/**
	 * What this test validates:
	 * A follower forwarding a write with an empty-string value must preserve it as a write,
	 * not reinterpret it as a delete.
	 *
	 * How it validates it:
	 * 1) Queue an empty-string write on a follower via put(key, "").
	 * 2) Run one follower step to trigger forwarding to the current leader.
	 * 3) Assert leader sees the exact empty-string value and not null.
	 */
	it("forwards empty-string writes as writes (not deletes)", async () => {
		// Arrange
		const config = createTestConfig(3);
		const [leader, followerA, followerB] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, followerA, followerB] as const;

		await followerA.put("empty-value-key", "");

		// Act
		await followerA.step(nodes);

		// Assert
		expect(leader.pendingWrites.has("empty-value-key")).toBe(true);
		expect(leader.pendingWrites.get("empty-value-key")).toBe("");
		expect(leader.pendingWrites.get("empty-value-key")).not.toBeNull();
	});

	/**
	 * What this test validates:
	 * Forwarding keeps exact value semantics for mixed operations, including empty strings.
	 *
	 * How it validates it:
	 * 1) Queue a mix of writes and deletes on followers: empty string, non-empty string, and delete.
	 * 2) Step followers so all operations are forwarded to the current leader.
	 * 3) Assert each key's final queued value on leader matches the intended operation exactly.
	 */
	it("preserves mixed forwarded operations exactly, including empty-string writes", async () => {
		// Arrange
		const config = createTestConfig(3);
		const [leader, followerA, followerB] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const nodes = [leader, followerA, followerB] as const;

		await followerA.put("k-empty", "");
		await followerA.put("k-text", "hello");
		await followerB.delete("k-delete");

		// Act
		await followerA.step(nodes);
		await followerB.step(nodes);

		// Assert
		expect(leader.pendingWrites.get("k-empty")).toBe("");
		expect(leader.pendingWrites.get("k-text")).toBe("hello");
		expect(leader.pendingWrites.get("k-delete")).toBeNull();
	});
});