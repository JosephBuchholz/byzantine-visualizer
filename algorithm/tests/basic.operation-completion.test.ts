import { describe, expect, it } from "vitest";
import { type HotStuffConfig } from "../src/index.js";
import BasicHotStuffNode from "../src/hotstuff/basic.js";
import { InMemoryDataStore } from "../src/data/store.js";

/** Build deterministic config for operation-lifecycle completion tests. */
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

/** Helper to create nodes with isolated in-memory state. */
function createTestNode(id: number, config: Required<HotStuffConfig>): BasicHotStuffNode {
	return new BasicHotStuffNode(id, config, new InMemoryDataStore());
}

/**
 * Drive one full Basic HotStuff round in a deterministic step order:
 * leader proposes, followers vote each phase, leader aggregates and advances phases,
 * then followers process DECIDE.
 */
async function driveOneFullRound(
	nodes: readonly [BasicHotStuffNode, BasicHotStuffNode, BasicHotStuffNode],
) {
	const [leader, followerA, followerB] = nodes;

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
}

describe("Basic HotStuff commit-aware operation completion", () => {
	/**
	 * What this test validates:
	 * put() should not resolve when merely enqueued or proposed; it should resolve only after
	 * DECIDE executes the committed write on the issuing node.
	 *
	 * How it validates it:
	 * 1) Call put() on the leader and track whether its returned promise settles.
	 * 2) Assert it remains unresolved before consensus/DECIDE completes.
	 * 3) Drive a full consensus round and assert the promise settles afterward.
	 */
	it("put promise stays pending before DECIDE and resolves after commit execution", async () => {
		// Arrange
		const config = createTestConfig(3);
		const nodes: [BasicHotStuffNode, BasicHotStuffNode, BasicHotStuffNode] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const [leader] = nodes;

		let settled = false;
		const opPromise = leader.put("op-put-key", "op-put-value").then(() => {
			settled = true;
		});

		// Let promise microtasks run, then check it is still pending pre-commit.
		await Promise.resolve();

		// Assert (pre-commit)
		expect(settled).toBe(false);

		// Act
		await driveOneFullRound(nodes);
		await opPromise;

		// Assert (post-commit)
		expect(settled).toBe(true);
		expect(await leader.read("op-put-key")).toBe("op-put-value");
	});

	/**
	 * What this test validates:
	 * delete() should not resolve when queued; it should resolve only after DECIDE executes
	 * the delete on the issuing node.
	 *
	 * How it validates it:
	 * 1) Seed leader datastore with a key, then call delete() and track settle state.
	 * 2) Assert promise stays pending before DECIDE.
	 * 3) Drive one full round and assert promise settles only after key is actually removed.
	 */
	it("delete promise stays pending before DECIDE and resolves after commit execution", async () => {
		// Arrange
		const config = createTestConfig(3);
		const nodes: [BasicHotStuffNode, BasicHotStuffNode, BasicHotStuffNode] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const [leader] = nodes;

		await leader.dataStore.put("op-delete-key", "to-remove");

		let settled = false;
		const opPromise = leader.delete("op-delete-key").then(() => {
			settled = true;
		});

		// Let promise microtasks run, then check it is still pending pre-commit.
		await Promise.resolve();

		// Assert (pre-commit)
		expect(settled).toBe(false);

		// Act
		await driveOneFullRound(nodes);
		await opPromise;

		// Assert (post-commit)
		expect(settled).toBe(true);
		expect(await leader.read("op-delete-key")).toBeNull();
	});

	/**
	 * What this test validates:
	 * For follower-issued writes, completion must still be commit-aware: forwarding to leader
	 * must not resolve the follower's put() early; only follower-side DECIDE execution may resolve it.
	 *
	 * How it validates it:
	 * 1) Call put() on a follower and track settle state.
	 * 2) Step follower once so it forwards the write to leader.
	 * 3) Assert promise remains pending after forwarding.
	 * 4) Drive one full round and assert promise resolves when follower applies DECIDE.
	 */
	it("follower-issued put does not resolve on forward and resolves after follower DECIDE", async () => {
		// Arrange
		const config = createTestConfig(3);
		const nodes: [BasicHotStuffNode, BasicHotStuffNode, BasicHotStuffNode] = [
			createTestNode(0, config),
			createTestNode(1, config),
			createTestNode(2, config),
		];
		const [leader, followerA] = nodes;

		let settled = false;
		const opPromise = followerA.put("follower-put-key", "follower-put-value").then(() => {
			settled = true;
		});

		// Let promise microtasks run, then verify it is still pending before any consensus steps.
		await Promise.resolve();
		expect(settled).toBe(false);

		// Act (forward only)
		await followerA.step(nodes);

		// Assert (after forward, still not committed)
		expect(leader.pendingWrites.get("follower-put-key")).toBe("follower-put-value");
		expect(settled).toBe(false);

		// Act (complete consensus and execution)
		await driveOneFullRound(nodes);
		await opPromise;

		// Assert (resolved only after follower executes DECIDE)
		expect(settled).toBe(true);
		expect(await followerA.read("follower-put-key")).toBe("follower-put-value");
	});
});
