// Small key/value abstraction so the simulator can swap storage backends without touching protocol logic.
export interface DataStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * Simple in-memory store used by each node during simulation.
 * Keeps protocol logic deterministic and avoids external storage dependencies.
 */
export class InMemoryDataStore implements DataStore {
	private store: Map<string, string> = new Map();

	/** Return the value for a key or null when absent. */
	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	/** Persist or overwrite a key/value pair in memory. */
	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	/** Remove a key if present; no-op otherwise. */
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
}
