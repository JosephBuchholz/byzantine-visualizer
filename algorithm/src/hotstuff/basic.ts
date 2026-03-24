import type { DataStore } from "../data/store.js";
import type { HotStuffConfig, HotStuffNode } from "../index.js";
import {
	type Block,
	FailState,
	LogLevel,
	type HotStuffMessage,
	type LeaderState,
	MessageKind,
	type PrepareMessage,
	type PreCommitMessage,
	type QuorumCertificate,
	type VoteMessage,
	type ReplicaState,
} from "../types.js";
import { Result } from "better-result";

interface WriteBatch {
	lastBatchTime: Date;
	writes: { key: string; value: string | null }[];
}

export default class BasicHotStuffNode implements HotStuffNode {
	readonly id: number;
	readonly config: Required<HotStuffConfig>;
	readonly dataStore: DataStore;
	readonly replicaState: ReplicaState;

	messageQueue: HotStuffMessage[] = [];
	pendingWrites: Map<string, string | null> = new Map();
	lastWriteBatch: WriteBatch | null = null;
	leaderState: LeaderState | null = null;

	abortResolver: (() => void) | null = null;
	pauseController: Promise<void> | null = null;
	pauseEnteredResolver: (() => void) | null = null;

	constructor(id: number, config: Required<HotStuffConfig>, dataStore: DataStore) {
		this.id = id;
		this.config = config;
		this.dataStore = dataStore;
		this.replicaState = {
			id,
			viewNumber: 0,
			lockedQC: null,
			prepareQC: null,
			committedBlocks: [],
		};
	}

	async put(key: string, value: string): Promise<void> {
		this.pendingWrites.set(key, value);

		// todo: promise should resolve when the write is committed
	}

	async delete(key: string): Promise<void> {
		this.pendingWrites.set(key, null);

		// todo: promise should resolve when the delete is committed
	}

	async read(key: string): Promise<string | null> {
		return this.dataStore.get(key);
	}

	message(m: HotStuffMessage): void {
		this.messageQueue.push(m);
	}

	async abort(): Promise<Result<void, "NodeAlreadyAborted">> {
		this.config.logger(LogLevel.Info, this.id, "Abort signal received.");

		if (this.abortResolver) {
			this.config.logger(
				LogLevel.Warning,
				this.id,
				"Node is already aborting. Ignoring additional abort signal.",
			);
			return Promise.resolve(Result.err("NodeAlreadyAborted"));
		}

		const { promise, resolve } = Promise.withResolvers<void>();
		this.abortResolver = resolve;
		return promise.then(() => Result.ok());
	}

	async pause(controller: Promise<void>): Promise<Result<void, "NodeAlreadyPaused">> {
		this.config.logger(LogLevel.Info, this.id, "Pause signal received.");

		if (this.pauseController) {
			this.config.logger(
				LogLevel.Warning,
				this.id,
				"Node is already paused. Ignoring additional pause signal.",
			);
			return Promise.resolve(Result.err("NodeAlreadyPaused"));
		}

		const { promise, resolve } = Promise.withResolvers<void>();
		this.pauseController = controller;
		this.pauseEnteredResolver = resolve;

		return promise.then(() => Result.ok());
	}

	async run(nodes: readonly Readonly<HotStuffNode>[]): Promise<Result<void, FailState>> {
		if (nodes.length < 1) {
			this.log(LogLevel.Error, "No nodes provided to run the algorithm.");
			return Result.err(FailState.NoNodesDefined);
		}

		if (nodes.length !== this.config.numNodes) {
			this.log(LogLevel.Error, `Expected ${this.config.numNodes} nodes, but got ${nodes.length}.`);
			return Result.err(FailState.NodeSizeConfigMismatch);
		}

		if (this.isLeader(nodes)) {
			this.log(LogLevel.Info, "Node is starting as leader.");
			this.leaderState = {
				...this.replicaState,
				pendingVotes: new Map(),
				collectedNewViews: [],
			};
		}

		while (!this.abortResolver) {
			// Check for pause signal
			if (this.pauseController) {
				this.log(LogLevel.Info, "Node is paused.");
				this.pauseEnteredResolver?.();
				this.pauseEnteredResolver = null;
				await this.pauseController;

				this.log(LogLevel.Info, "Node is resuming.");
				this.pauseController = null;
			}

			await this.step(nodes);

			// Sleep for a random short duration to simulate processing time and allow other nodes to run
			await new Promise((resolve) =>
				setTimeout(resolve, Math.random() * this.config.loopTimeoutMaxMs),
			);
		}

		// process aborted
		this.log(LogLevel.Info, "Node is aborting.");
		this.abortResolver();

		return Result.ok();
	}

	async step(nodes: readonly Readonly<HotStuffNode>[]): Promise<void> {
		// Process every hot stuff message seen so far in the message queue
		const hsMessageLength = this.messageQueue.length;
		for (let i = 0; i < hsMessageLength; i++) {
			const message = this.messageQueue.shift()!;
			switch (message.type) {
				case MessageKind.Prepare:
					// Follower path: validate proposal safety then reply with a PREPARE vote.
					await this.handlePrepareMessage(message, nodes);
					break;
				case MessageKind.PreCommit:
					// Follower path: accept leader's prepareQC and return a PRE-COMMIT vote.
					await this.handlePreCommitMessage(message, nodes);
					break;
				case MessageKind.Vote:
					// Leader path: aggregate votes toward a QC and advance the phase when quorum forms.
					await this.handleVoteMessage(message, nodes);
					break;
				default:
					// Other phases not yet implemented.
					break;
			}
		}

		if (this.leaderState) {
			this.lastWriteBatch ??= { lastBatchTime: new Date(), writes: [] };

			const elapsedSinceLastBatch = Date.now() - this.lastWriteBatch.lastBatchTime.getTime();
			const batchDue =
				this.pendingWrites.size >= this.config.maxBatchSize ||
				elapsedSinceLastBatch >= this.config.maxBatchWaitTimeMs;
			if (this.pendingWrites.size > 0 && batchDue) {
				this.log(
					LogLevel.Info,
					`Creating new proposal with ${this.pendingWrites.size} data store messages.`,
				);

				// Move pending writes to lastWriteBatch
				this.lastWriteBatch = {
					lastBatchTime: new Date(),
					writes: Array.from(this.pendingWrites.entries()).map(([key, value]) => ({ key, value })),
				};
				this.pendingWrites.clear();

				this.propose(nodes);
			}

			return;
		}

		// If not leader, forward pending writes to leader
		if (this.pendingWrites.size > 0) {
			const leader = this.findLeader(nodes);
			this.log(
				LogLevel.Info,
				`Forwarding ${this.pendingWrites.size} pending writes to leader (Node ${leader.id}).`,
			);

			// Forward pending writes to leader
			for (const [key, value] of this.pendingWrites.entries()) {
				await (value ? leader.put(key, value) : leader.delete(key));
			}

			this.pendingWrites.clear();
		}
	}

	private propose(nodes: readonly Readonly<HotStuffNode>[]) {
		if (!this.lastWriteBatch) {
			return;
		}

		// For the parent hash, we use the prepareQC's node hash if it exists,
		// otherwise we fall back to the lockedQC's node hash.
		// If neither exists (i.e. this is the first proposal), we use a special "GENESIS" hash.
		const parentHash =
			this.replicaState.prepareQC?.nodeHash ?? this.replicaState.lockedQC?.nodeHash ?? "GENESIS";
		const justify = this.replicaState.prepareQC ?? this.replicaState.lockedQC ?? genesisQC();

		const blockData = {
			writes: this.lastWriteBatch.writes,
			viewNumber: this.replicaState.viewNumber,
			leaderId: this.id,
			createdAt: this.lastWriteBatch.lastBatchTime.toISOString(),
		};

		const block: Block = {
			hash: blockHash(this.id, this.replicaState.viewNumber, parentHash, blockData),
			parentHash,
			data: blockData,
			height: this.replicaState.committedBlocks.length + 1,
		};

		const prepareMessage: PrepareMessage = {
			type: MessageKind.Prepare,
			viewNumber: this.replicaState.viewNumber,
			senderId: this.id,
			node: {
				block,
				parentHash,
				justify,
			},
		};

		// Broadcast prepare message to all replicas.
		let recipients = 0;
		for (const node of nodes) {
			if (node.id !== this.id) {
				node.message(prepareMessage);
				recipients++;
			}
		}

		this.log(
			LogLevel.Info,
			`Proposed block ${block.hash} at view ${this.replicaState.viewNumber} to ${recipients} replicas.`,
		);

		// Leader casts its own PREPARE vote immediately to start quorum aggregation.
		void this.handleVoteMessage(
			{
				type: MessageKind.Vote,
				voteType: MessageKind.Prepare,
				nodeHash: block.hash,
				partialSig: `sig-${this.id}-${block.hash}`,
				viewNumber: this.replicaState.viewNumber,
				senderId: this.id,
			},
			nodes,
		);
	}

	/**
	 * Determined by the view number and the number of nodes.
	 */
	findLeader(nodes: readonly Readonly<HotStuffNode>[]): Readonly<HotStuffNode> {
		const leaderIndex = this.replicaState.viewNumber % nodes.length;
		return nodes[leaderIndex]!;
	}

	isLeader(nodes: readonly Readonly<HotStuffNode>[]): boolean {
		return this.id === this.findLeader(nodes).id;
	}

	private quorumSize(): number {
		// Quorum rule: need 2f+1 = floor(2n/3)+1 votes to form a QC.
		return Math.floor((this.config.numNodes * 2) / 3) + 1;
	}

	private findNodeById(
		nodes: readonly Readonly<HotStuffNode>[],
		nodeId: number,
	): Readonly<HotStuffNode> | null {
		return nodes.find((n) => n.id === nodeId) ?? null;
	}

	private async handlePrepareMessage(
		message: PrepareMessage,
		nodes: readonly Readonly<HotStuffNode>[],
	): Promise<void> {
		// Structural validity: proposed node must directly extend the QC it justifies.
		const extendsJustify = message.node.parentHash === message.node.justify.nodeHash;
		if (!extendsJustify) {
			this.log(LogLevel.Warning, `Rejected PREPARE for ${message.node.block.hash}: invalid parent.`);
			return;
		}

		// SafeNode predicate (simplified): extend lock or justify is newer.
		const locked = this.replicaState.lockedQC;
		const isDescendantOfLock = locked ? message.node.parentHash === locked.nodeHash : true;
		const justifyIsNewer = locked ? message.node.justify.viewNumber > locked.viewNumber : true;
		if (!isDescendantOfLock && !justifyIsNewer) {
			this.log(LogLevel.Warning, `Rejected PREPARE for ${message.node.block.hash}: not safe.`);
			return;
		}

		// Track the freshest view/QC we have observed for subsequent proposals.
		this.replicaState.viewNumber = Math.max(this.replicaState.viewNumber, message.viewNumber);
		this.replicaState.prepareQC = message.node.justify;

		const leader = this.findNodeById(nodes, message.senderId);
		if (!leader) {
			this.log(LogLevel.Error, `Cannot find leader ${message.senderId} to send PREPARE vote.`);
			return;
		}

		const vote: VoteMessage = {
			type: MessageKind.Vote,
			voteType: MessageKind.Prepare,
			nodeHash: message.node.block.hash,
			partialSig: `sig-${this.id}-${message.node.block.hash}`,
			viewNumber: message.viewNumber,
			senderId: this.id,
		};

		leader.message(vote);
		this.log(LogLevel.Info, `Voted PREPARE for ${message.node.block.hash} (view ${message.viewNumber}).`);
	}

	private async handlePreCommitMessage(
		message: PreCommitMessage,
		nodes: readonly Readonly<HotStuffNode>[],
	): Promise<void> {
		if (message.justify.nodeHash !== message.nodeHash) {
			this.log(LogLevel.Warning, `Rejected PRE-COMMIT for ${message.nodeHash}: QC mismatch.`);
			return;
		}

		// Adopt the leader's prepareQC as our highest seen and advance view.
		this.replicaState.prepareQC = message.justify;
		this.replicaState.viewNumber = Math.max(this.replicaState.viewNumber, message.viewNumber);

		const leader = this.findLeader(nodes);
		const vote: VoteMessage = {
			type: MessageKind.Vote,
			voteType: MessageKind.PreCommit,
			nodeHash: message.nodeHash,
			partialSig: `pc-sig-${this.id}-${message.nodeHash}`,
			viewNumber: message.viewNumber,
			senderId: this.id,
		};

		leader.message(vote);
		this.log(LogLevel.Info, `Voted PRE-COMMIT for ${message.nodeHash} (view ${message.viewNumber}).`);
	}

	private async handleVoteMessage(
		vote: VoteMessage,
		nodes: readonly Readonly<HotStuffNode>[],
	): Promise<void> {
		if (!this.leaderState) {
			return; // Only the leader aggregates votes
		}

		const votesForNode = this.leaderState.pendingVotes.get(vote.nodeHash) ?? [];
		if (votesForNode.some((v) => v.senderId === vote.senderId)) {
			return; // Ignore duplicates from the same sender
		}

		votesForNode.push(vote);
		this.leaderState.pendingVotes.set(vote.nodeHash, votesForNode);

		if (votesForNode.length < this.quorumSize()) {
			return; // Need more votes to form a QC
		}

		// Combine partial signatures into a QC once quorum is met.
		const qc: QuorumCertificate = {
			type: vote.voteType,
			viewNumber: vote.viewNumber,
			nodeHash: vote.nodeHash,
			thresholdSig: votesForNode.map((v) => v.partialSig).join("|"),
		};

		if (vote.voteType === MessageKind.Prepare) {
			this.replicaState.prepareQC = qc;
			this.leaderState.prepareQC = qc;

			// Move into PRE-COMMIT: broadcast the prepareQC so replicas lock and vote PreCommit.
			const preCommit: PreCommitMessage = {
				type: MessageKind.PreCommit,
				viewNumber: vote.viewNumber,
				senderId: this.id,
				nodeHash: vote.nodeHash,
				justify: qc,
			};

			for (const node of nodes) {
				if (node.id === this.id) {
					// Leader participates in next phase immediately.
					await this.handlePreCommitMessage(preCommit, nodes);
					continue;
				}
				node.message(preCommit);
			}

			this.log(LogLevel.Info, `Broadcast PRE-COMMIT for ${vote.nodeHash} with QC.`);
		}
	}

	private log(level: LogLevel, message: string) {
		this.config.logger?.(level, this.id, message);
	}
}

function blockHash(id: number, view: number, parentHash: string, data: unknown): string {
	const raw = `${id}:${view}:${parentHash}:${JSON.stringify(data)}`;
	return `b-${raw.length}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function genesisQC(): QuorumCertificate {
	return {
		type: MessageKind.NewView,
		viewNumber: 0,
		nodeHash: "GENESIS",
		thresholdSig: "GENESIS_SIG",
	};
}
