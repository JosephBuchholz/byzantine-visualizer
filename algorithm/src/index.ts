import type { Result } from "better-result";
import BasicHotStuffNode from "./hotstuff/basic.js";
import type { FailState, HotStuffMessage, LogLevel } from "./types.js";
import { InMemoryDataStore } from "./data/store.js";

// Public surface for the simulator: defines the HotStuff node contract and exposes a helper to build
// a configured BasicHotStuffNode with a fresh in-memory datastore.

// Node-level tuning knobs that mirror the simulator's runtime behavior.
export interface HotStuffConfig {
	numNodes: number;
	loopTimeoutMaxMs: number;
	leaderTimeoutMaxMs: number;
	maxBatchSize: number;
	maxBatchWaitTimeMs: number;
	logger?: (level: LogLevel, id: number, message: string) => void;
}

// Contract exposed to the rest of the simulator; implemented by BasicHotStuffNode.
export interface HotStuffNode {
	id: number;
	config: HotStuffConfig;

	/**
	 * Enqueues a message for processing by the node. The message will be processed in the order it was received.
	 * @param m The message to be processed by the node.
	 */
	message(m: HotStuffMessage): void;

	/**
	 * Puts a key-value pair to the node's data store.
	 * Forwards the write to the leader if this node is not the leader for the current view.
	 */
	put(key: string, value: string): Promise<void>;

	/**
	 * Deletes a key-value pair from the node's data store by key. If the key does not exist, this operation is a no-op.
	 */
	delete(key: string): Promise<void>;

	/**
	 * Reads a value from the node's data store by key. If the key does not exist, returns null.
	 */
	read(key: string): Promise<string | null>;

	/**
	 * Runs the HotStuff node's main loop until an abort signal is received.
	 * @param nodes An array of all nodes in the system.
	 */
	run(nodes: HotStuffNode[]): Promise<Result<void, FailState>>;

	/**
	 * Sends a pause signal to the node, causing it to halt processing.
	 * @param controller A promise that controls the pause state of the node. When this promise resolves, the node will resume operation.
	 *
	 * @returns A promise that resolves when the node is paused.
	 * The node will remain paused until the controller promise resolves.
	 */
	pause(controller: Promise<void>): Promise<Result<void, "NodeAlreadyPaused">>;

	/**
	 * Sends a graceful abort signal to the node.
	 * @returns A promise that resolves when the node has completed its shutdown process.
	 */
	abort(): Promise<Result<void, "NodeAlreadyAborted">>;
}

/**
 * Fallback logger used when the caller does not provide one.
 * Includes a timestamp and node id so protocol events are easy to correlate across replicas.
 */
function defaultLogger(level: LogLevel, id: number, message: string) {
	const tag = `[${new Date().toISOString()}] Node ${id}`;
	console.log(`${tag} ${level}: ${message}`);
}

/**
 * Factory for creating a fully configured simulator node.
 * Ensures every node has a logger and a fresh isolated in-memory datastore.
 */
export function defineNode(id: number, config: HotStuffConfig): HotStuffNode {
	// If the caller did not provide a logger in the config, use defaultLogger as the fallback
	config.logger ??= defaultLogger;

	// Create and return a brand new HotStuff node with:
	// - id: the node's unique identifier
	// - config as Required<HotStuffConfig>: the fully complete config (logger is now guaranteed to exist)
	// - new InMemoryDataStore(): a brand new empty data store for this node to use
	return new BasicHotStuffNode(id, config as Required<HotStuffConfig>, new InMemoryDataStore());
}
