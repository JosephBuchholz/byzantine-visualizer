export interface DataStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export class InMemoryDataStore implements DataStore {
	private store: Map<string, string> = new Map();

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
}
