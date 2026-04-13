import type { DataStore } from "../data/store.js";
import type { HotStuffConfig, HotStuffNode } from "../index.js";
import {
	type Block,
	FailState,
	LogLevel,
	type HotStuffMessage,
	type LeaderState,
	MessageKind,
	type CommitMessage,
	type DecideMessage,
	type NewViewMessage,
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

/**
 * Minimal HotStuff replica/leader used for visualization: maintains local state, batches client writes,
 * forwards them to the current leader, and drives Prepare → Pre-Commit when acting as leader.
 */
export default class BasicHotStuffNode implements HotStuffNode {
	readonly id: number;
	readonly config: Required<HotStuffConfig>;
	readonly dataStore: DataStore;
	readonly replicaState: ReplicaState;

	messageQueue: HotStuffMessage[] = [];
	pendingWrites: Map<string, string | null> = new Map();
	knownBlocksByHash: Map<string, Block> = new Map();
	lastWriteBatch: WriteBatch | null = null;
	leaderState: LeaderState | null = null;
	stepsWithoutProgress = 0;
	timeoutBackoffExponent = 0;
	suppressTimeoutForView: number | null = null;

	abortResolver: (() => void) | null = null;
	pauseController: Promise<void> | null = null;
	pauseEnteredResolver: (() => void) | null = null;

	/** Create a node with a clean state and attach its storage and runtime config. */
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

	/**
	 * Queue a client write for consensus.
	 * The write is not applied immediately; it is batched and later proposed by the current leader.
	 */
	async put(key: string, value: string): Promise<void> {
		this.pendingWrites.set(key, value);

		// todo: promise should resolve when the write is committed
	}

	/**
	 * Queue a client delete operation for consensus.
	 * A null value marks deletion and follows the same batching/proposal path as writes.
	 */
	async delete(key: string): Promise<void> {
		this.pendingWrites.set(key, null);

		// todo: promise should resolve when the delete is committed
	}

	/**
	 * Read from local state only.
	 * This simulation does not block reads on finality; it returns the node's current datastore value.
	 */
	async read(key: string): Promise<string | null> {
		return this.dataStore.get(key);
	}

	/** Enqueue an incoming HotStuff protocol message for later processing. */
	message(m: HotStuffMessage): void {
		this.messageQueue.push(m);
	}

	/** Begin graceful shutdown; resolves once the main loop observes the abort. */
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

		let resolve!: () => void;
		const promise = new Promise<void>((res) => {
			resolve = res;
		});
		this.abortResolver = resolve;
		return promise.then(() => Result.ok());
	}

	/**
	 * Enter a cooperative pause state controlled by an external promise.
	 * The run loop acknowledges the pause, then resumes once the controller promise resolves.
	 */
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

		let resolve!: () => void;
		const promise = new Promise<void>((res) => {
			resolve = res;
		});
		this.pauseController = controller;
		this.pauseEnteredResolver = resolve;

		return promise.then(() => Result.ok());
	}

	/**
	 * Main event loop for a node.
	 * It validates startup assumptions, initializes leader-only state for the current view,
	 * repeatedly processes one protocol step, and exits gracefully on abort.
	 */
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

	/**
	 * Execute one simulation tick.
	 * First drain inbound protocol messages, then either:
	 * 1) leader path: batch client operations and propose when batch conditions are met, or
	 * 2) follower path: forward pending client operations to the current leader.
	 */
	async step(nodes: readonly Readonly<HotStuffNode>[]): Promise<void> {
		let madeProgress = false;

		// Process a stable snapshot of the current queue so messages enqueued during this step
		// are handled in the next tick, preserving deterministic phase boundaries.
		// Process every hot stuff message seen so far in the message queue
		const hsMessageLength = this.messageQueue.length;
		if (hsMessageLength > 0) {
			madeProgress = true;
		}
		for (let i = 0; i < hsMessageLength; i++) {
			const message = this.messageQueue.shift()!;
			switch (message.type) {
				case MessageKind.NewView:
					// Leader path: collect NEW-VIEW evidence for future proposal selection.
					this.handleNewViewMessage(message);
					break;
				case MessageKind.Prepare:
					// Follower path: validate proposal safety then reply with a PREPARE vote.
					await this.handlePrepareMessage(message, nodes);
					break;
				case MessageKind.PreCommit:
					// Follower path: accept leader's prepareQC and return a PRE-COMMIT vote.
					await this.handlePreCommitMessage(message, nodes);
					break;
				case MessageKind.Commit:
					// Follower path: validate precommitQC, lock on it, and return a COMMIT vote.
					await this.handleCommitMessage(message, nodes);
					break;
				case MessageKind.Decide:
					// Follower path: validate commitQC, execute block writes, and finalize this view.
					await this.handleDecideMessage(message, nodes);
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
			// For view > 0, require NEW-VIEW quorum before proposing so leader has highQC evidence.
			if (this.replicaState.viewNumber > 0) {
				const hasNewViewQuorum = this.newViewEvidenceCount() >= this.quorumSize();
				if (!hasNewViewQuorum) {
					this.maybeTimeoutToNextView(nodes, madeProgress);
					return;
				}

				// Select the highest QC seen in NEW-VIEW messages and use it as prepare baseline.
				const highQC = this.selectHighQCFromNewViews();
				if (highQC) {
					this.replicaState.prepareQC = highQC;
					this.leaderState.prepareQC = highQC;
				}
			}

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
				madeProgress = true;

				// Move pending writes to lastWriteBatch
				this.lastWriteBatch = {
					lastBatchTime: new Date(),
					writes: Array.from(this.pendingWrites.entries()).map(([key, value]) => ({ key, value })),
				};
				this.pendingWrites.clear();

				this.propose(nodes);
			}

			this.maybeTimeoutToNextView(nodes, madeProgress);
			return;
		}

		// If not leader, forward pending writes to leader
		if (this.pendingWrites.size > 0) {
			const leader = this.findLeader(nodes);
			this.log(
				LogLevel.Info,
				`Forwarding ${this.pendingWrites.size} pending writes to leader (Node ${leader.id}).`,
			);
			madeProgress = true;

			// Forward pending writes to leader
			for (const [key, value] of this.pendingWrites.entries()) {
				await (value ? leader.put(key, value) : leader.delete(key));
			}

			this.pendingWrites.clear();
		}

		this.maybeTimeoutToNextView(nodes, madeProgress);
	}

	/** Leader-only: build a block from pending writes and broadcast a Prepare. */
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

		// Cache proposed blocks by hash so DECIDE can later execute their writes locally.
		this.knownBlocksByHash.set(block.hash, block);

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
	/** Deterministically pick the leader for the current view. */
	findLeader(nodes: readonly Readonly<HotStuffNode>[]): Readonly<HotStuffNode> {
		const leaderIndex = this.replicaState.viewNumber % nodes.length;
		return nodes[leaderIndex]!;
	}

	/** Deterministically pick the leader for an arbitrary target view. */
	private findLeaderForView(
		nodes: readonly Readonly<HotStuffNode>[],
		viewNumber: number,
	): Readonly<HotStuffNode> {
		const leaderIndex = viewNumber % nodes.length;
		return nodes[leaderIndex]!;
	}

	/** Convenience check: is this node the current leader? */
	isLeader(nodes: readonly Readonly<HotStuffNode>[]): boolean {
		return this.id === this.findLeader(nodes).id;
	}

	/** Compute the 2f+1 quorum threshold for vote aggregation. */
	private quorumSize(): number {
		// Quorum rule: need 2f+1 = floor(2n/3)+1 votes to form a QC.
		return Math.floor((this.config.numNodes * 2) / 3) + 1;
	}

	/** Utility: find a peer by id within the provided node list. */
	private findNodeById(
		nodes: readonly Readonly<HotStuffNode>[],
		nodeId: number,
	): Readonly<HotStuffNode> | null {
		return nodes.find((n) => n.id === nodeId) ?? null;
	}

	/**
	 * Leader-only NEW-VIEW intake.
	 * Collects view-change evidence for the current view and deduplicates by sender
	 * so one replica cannot inflate quorum counts.
	 */
	private handleNewViewMessage(message: NewViewMessage): void {
		if (!this.leaderState) {
			return;
		}

		// Ignore stale NEW-VIEW evidence from older views.
		if (message.viewNumber < this.replicaState.viewNumber) {
			return;
		}

		// If a newer view is observed, synchronize leader view state and restart collection
		// for that target view so quorum accounting remains view-specific.
		if (message.viewNumber > this.replicaState.viewNumber) {
			this.replicaState.viewNumber = message.viewNumber;
			this.leaderState.viewNumber = message.viewNumber;
			this.leaderState.collectedNewViews = [];
		}

		// Keep one NEW-VIEW record per sender and retain the freshest QC evidence.
		const existingIndex = this.leaderState.collectedNewViews.findIndex(
			(collected) => collected.senderId === message.senderId,
		);
		if (existingIndex >= 0) {
			const existing = this.leaderState.collectedNewViews[existingIndex]!;
			if (message.lockedQC.viewNumber > existing.lockedQC.viewNumber) {
				this.leaderState.collectedNewViews[existingIndex] = message;
			}
			return;
		}

		this.leaderState.collectedNewViews.push(message);
	}

	/**
	 * Choose the highest QC carried by collected NEW-VIEW messages.
	 * This acts as the leader's highQC and anchors the next safe proposal.
	 */
	private selectHighQCFromNewViews(): QuorumCertificate | null {
		if (!this.leaderState) {
			return null;
		}

		// Start with leader-local QC evidence so self NEW-VIEW contributes to highQC selection.
		let highest = this.replicaState.prepareQC ?? this.replicaState.lockedQC ?? genesisQC();
		for (const message of this.leaderState.collectedNewViews) {
			if (message.lockedQC.viewNumber > highest.viewNumber) {
				highest = message.lockedQC;
			}
		}

		return highest;
	}

	/**
	 * Count NEW-VIEW evidence available to the leader for the current view.
	 * Includes external collected messages plus leader-local evidence as one self-vote.
	 */
	private newViewEvidenceCount(): number {
		if (!this.leaderState) {
			return 0;
		}

		const hasSelfEvidence =
			this.replicaState.prepareQC !== null || this.replicaState.lockedQC !== null;
		return this.leaderState.collectedNewViews.length + (hasSelfEvidence ? 1 : 0);
	}

	/**
	 * Transition helper used by completion and timeout paths.
	 * Moves local state into a target view and emits a single NEW-VIEW message to that view's leader.
	 */
	private advanceToNextView(
		nodes: readonly Readonly<HotStuffNode>[],
		targetView: number,
		reason: "completion" | "timeout",
	): void {
		const nextView = Math.max(targetView, this.replicaState.viewNumber + 1);
		if (nextView <= this.replicaState.viewNumber) {
			return;
		}

		this.replicaState.viewNumber = nextView;
		if (this.leaderState) {
			this.leaderState.viewNumber = nextView;
			this.leaderState.pendingVotes.clear();
			this.leaderState.collectedNewViews = [];
		}

		// Carry the highest local QC evidence into NEW-VIEW, falling back to genesis when empty.
		const carriedQC = this.replicaState.prepareQC ?? this.replicaState.lockedQC ?? genesisQC();
		const newView: NewViewMessage = {
			type: MessageKind.NewView,
			viewNumber: nextView,
			senderId: this.id,
			lockedQC: carriedQC,
			partialSig: `nv-sig-${this.id}-${nextView}-${carriedQC.nodeHash}`,
		};

		// Send to the deterministic leader of the transitioned view.
		// Queueing even for self keeps the message path uniform and observable in tests.
		const nextLeader = this.findLeaderForView(nodes, nextView);
		nextLeader.message(newView);

		// Timeout backoff grows only on timeout transitions and resets on completion.
		if (reason === "timeout") {
			this.timeoutBackoffExponent += 1;
			this.suppressTimeoutForView = null;
		} else {
			this.timeoutBackoffExponent = 0;
			// After a successful completion-driven transition, suppress immediate timeout churn
			// in the just-entered view until some subsequent progress arrives.
			this.suppressTimeoutForView = nextView;
		}

		this.stepsWithoutProgress = 0;
		this.log(
			LogLevel.Info,
			`Transitioned to view ${nextView} via ${reason}; sent NEW-VIEW to leader ${nextLeader.id}.`,
		);
	}

	/**
	 * Compute the current timeout threshold in steps.
	 * Uses exponential backoff: base * 2^k where k is the number of consecutive timeout transitions.
	 */
	private currentTimeoutThresholdSteps(): number {
		const base = Math.max(1, this.config.leaderTimeoutMaxMs);
		return base * 2 ** this.timeoutBackoffExponent;
	}

	/**
	 * Timeout guard for liveness.
	 * Tracks consecutive no-progress steps and triggers a single timeout-based view transition
	 * per current view to avoid repeated NEW-VIEW spam.
	 */
	private maybeTimeoutToNextView(
		nodes: readonly Readonly<HotStuffNode>[],
		madeProgress: boolean,
	): void {
		if (madeProgress) {
			this.stepsWithoutProgress = 0;
			// Any observed progress resets liveness timeout backoff pressure.
			this.timeoutBackoffExponent = 0;
			this.suppressTimeoutForView = null;
			return;
		}

		if (this.suppressTimeoutForView === this.replicaState.viewNumber) {
			return;
		}

		this.stepsWithoutProgress += 1;
		if (this.stepsWithoutProgress <= this.currentTimeoutThresholdSteps()) {
			return;
		}

		this.advanceToNextView(nodes, this.replicaState.viewNumber + 1, "timeout");
	}

	/**
	 * Check whether a candidate block extends (is a descendant of) an ancestor hash.
	 * This walks parent links through the maintained local block tree and returns false if
	 * ancestry evidence is missing, preserving safety when local history is incomplete.
	 */
	private isBlockDescendantOf(candidate: Block, ancestorHash: string): boolean {
		// Quick accept for direct parent linkage and self-equality.
		if (candidate.hash === ancestorHash || candidate.parentHash === ancestorHash) {
			return true;
		}

		// Traverse parent pointers until we either find the ancestor or lose proof.
		const visited = new Set<string>();
		let currentHash = candidate.parentHash;

		while (true) {
			if (visited.has(currentHash)) {
				return false;
			}
			visited.add(currentHash);

			if (currentHash === ancestorHash) {
				return true;
			}

			const current = this.knownBlocksByHash.get(currentHash);
			if (!current) {
				return false;
			}

			currentHash = current.parentHash;
		}
	}

	/** Replica path for PREPARE: validate safety, update local QC/view, and send a PREPARE vote. */
	private async handlePrepareMessage(
		message: PrepareMessage,
		nodes: readonly Readonly<HotStuffNode>[],
	): Promise<void> {
		// Structural validity: proposed node must directly extend the QC it justifies.
		const extendsJustify = message.node.parentHash === message.node.justify.nodeHash;
		if (!extendsJustify) {
			this.log(
				LogLevel.Warning,
				`Rejected PREPARE for ${message.node.block.hash}: invalid parent.`,
			);
			return;
		}

		// SafeNode predicate: descendant of lock (safety) OR newer justify (liveness).
		// The descendant check now uses full ancestry traversal over the maintained block tree
		// rather than a one-hop parent equality check.
		const locked = this.replicaState.lockedQC;
		const isDescendantOfLock = locked
			? this.isBlockDescendantOf(message.node.block, locked.nodeHash)
			: true;
		const justifyIsNewer = locked ? message.node.justify.viewNumber > locked.viewNumber : true;
		if (!isDescendantOfLock && !justifyIsNewer) {
			this.log(LogLevel.Warning, `Rejected PREPARE for ${message.node.block.hash}: not safe.`);
			return;
		}

		// Track the freshest view/QC we have observed for subsequent proposals.
		// Also cache the proposed block so we can execute it if a DECIDE later arrives.
		this.knownBlocksByHash.set(message.node.block.hash, message.node.block);
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
		this.log(
			LogLevel.Info,
			`Voted PREPARE for ${message.node.block.hash} (view ${message.viewNumber}).`,
		);
	}

	/**
	 * Replica path for PRE-COMMIT.
	 * Verifies that the QC matches the proposed node, adopts it as the latest known prepareQC,
	 * and returns a PRE-COMMIT vote to the leader.
	 */
	private async handlePreCommitMessage(
		message: PreCommitMessage,
		nodes: readonly Readonly<HotStuffNode>[],
	): Promise<void> {
		// Reject malformed PRE-COMMIT evidence where the carried QC does not certify the target node.
		if (message.justify.nodeHash !== message.nodeHash) {
			this.log(LogLevel.Warning, `Rejected PRE-COMMIT for ${message.nodeHash}: QC mismatch.`);
			return;
		}

		// Accept the PRE-COMMIT evidence as the highest known prepareQC and advance local view.
		// Adopt the leader's prepareQC as our highest seen and advance view.
		this.replicaState.prepareQC = message.justify;
		this.replicaState.viewNumber = Math.max(this.replicaState.viewNumber, message.viewNumber);

		// Emit a PRE-COMMIT vote back to the phase leader so it can aggregate a precommitQC.
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
		this.log(
			LogLevel.Info,
			`Voted PRE-COMMIT for ${message.nodeHash} (view ${message.viewNumber}).`,
		);
	}

	/**
	 * Replica path for COMMIT.
	 * Verifies the precommitQC evidence, updates lock state, and returns a COMMIT vote to the leader.
	 */
	private async handleCommitMessage(
		message: CommitMessage,
		nodes: readonly Readonly<HotStuffNode>[],
	): Promise<void> {
		// Reject malformed COMMIT evidence where the carried QC does not certify the target node.
		if (message.justify.nodeHash !== message.nodeHash) {
			this.log(LogLevel.Warning, `Rejected COMMIT for ${message.nodeHash}: QC mismatch.`);
			return;
		}

		// Lock on the validated precommitQC and move local view forward.
		// This is the HotStuff lock update that preserves safety across view changes.
		this.replicaState.lockedQC = message.justify;
		this.replicaState.viewNumber = Math.max(this.replicaState.viewNumber, message.viewNumber);

		// Return a COMMIT vote so the leader can aggregate a commitQC for the next phase.
		const leader = this.findNodeById(nodes, message.senderId);
		if (!leader) {
			this.log(LogLevel.Error, `Cannot find leader ${message.senderId} to send COMMIT vote.`);
			return;
		}

		const vote: VoteMessage = {
			type: MessageKind.Vote,
			voteType: MessageKind.Commit,
			nodeHash: message.nodeHash,
			partialSig: `c-sig-${this.id}-${message.nodeHash}`,
			viewNumber: message.viewNumber,
			senderId: this.id,
		};

		leader.message(vote);
		this.log(LogLevel.Info, `Voted COMMIT for ${message.nodeHash} (view ${message.viewNumber}).`);
	}

	/**
	 * Replica path for DECIDE.
	 * Verifies commitQC evidence, reconstructs the unexecuted branch from last executed block to tip,
	 * executes that branch in order, records newly committed blocks, and advances to the next view.
	 */
	private async handleDecideMessage(
		message: DecideMessage,
		nodes: readonly Readonly<HotStuffNode>[],
	): Promise<void> {
		// Reject malformed DECIDE evidence where the carried commitQC does not certify the target node.
		if (
			message.justify.nodeHash !== message.nodeHash ||
			message.justify.type !== MessageKind.Commit
		) {
			this.log(LogLevel.Warning, `Rejected DECIDE for ${message.nodeHash}: QC mismatch.`);
			return;
		}

		// Build the exact suffix that still needs execution: from the first unexecuted ancestor
		// to the decided tip. If ancestry cannot be proven locally, reject to avoid partial execution.
		const branchToExecute = this.buildUnexecutedBranch(message.nodeHash);
		if (!branchToExecute) {
			this.log(LogLevel.Warning, `Rejected DECIDE for ${message.nodeHash}: unknown block.`);
			return;
		}

		if (branchToExecute.length === 0) {
			// Idempotent replay: nothing new to execute, so do not mutate commit history or view.
			this.log(LogLevel.Info, `Ignored duplicate DECIDE for ${message.nodeHash}.`);
			return;
		}

		// Execute the branch in ancestor-to-tip order so state transitions are deterministic.
		for (const block of branchToExecute) {
			for (const write of this.extractWrites(block.data)) {
				if (write.value === null) {
					await this.dataStore.delete(write.key);
					continue;
				}
				await this.dataStore.put(write.key, write.value);
			}

			this.replicaState.committedBlocks.push(block);
		}

		// Completion path: after executing committed work, explicitly transition and send NEW-VIEW.
		this.advanceToNextView(nodes, message.viewNumber + 1, "completion");
		this.log(
			LogLevel.Info,
			`Decided block ${message.nodeHash}; executed ${branchToExecute.length} block(s).`,
		);
	}

	/**
	 * Reconstruct the unexecuted branch ending at the decided tip.
	 * Walks parent pointers from tip to the first already committed ancestor (or GENESIS),
	 * returning the branch in execution order. Returns null if ancestry evidence is incomplete.
	 */
	private buildUnexecutedBranch(tipHash: string): Block[] | null {
		const committedHashes = new Set(this.replicaState.committedBlocks.map((block) => block.hash));
		const pathFromTip: Block[] = [];
		const visited = new Set<string>();

		let currentHash = tipHash;
		while (true) {
			if (committedHashes.has(currentHash)) {
				break;
			}

			if (visited.has(currentHash)) {
				return null;
			}
			visited.add(currentHash);

			const current = this.knownBlocksByHash.get(currentHash);
			if (!current) {
				return null;
			}

			pathFromTip.push(current);

			if (current.parentHash === "GENESIS") {
				break;
			}

			currentHash = current.parentHash;
		}

		return pathFromTip.reverse();
	}

	/**
	 * Pull a write batch from opaque block data used by this simulator.
	 * Returns an empty list when the payload shape is not recognized.
	 */
	private extractWrites(data: unknown): { key: string; value: string | null }[] {
		if (!data || typeof data !== "object") {
			return [];
		}

		const maybeWrites = (data as { writes?: unknown }).writes;
		if (!Array.isArray(maybeWrites)) {
			return [];
		}

		return maybeWrites.filter(
			(write): write is { key: string; value: string | null } =>
				typeof write === "object" &&
				write !== null &&
				typeof (write as { key?: unknown }).key === "string" &&
				(typeof (write as { value?: unknown }).value === "string" ||
					(write as { value?: unknown }).value === null),
		);
	}

	/**
	 * Leader aggregation path.
	 * Collects votes by node hash, deduplicates by sender, forms a QC at quorum,
	 * and currently advances from PREPARE quorum to PRE-COMMIT broadcast.
	 */
	private async handleVoteMessage(
		vote: VoteMessage,
		nodes: readonly Readonly<HotStuffNode>[],
	): Promise<void> {
		// Only the current leader aggregates votes into QCs and advances phases.
		if (!this.leaderState) {
			return; // Only the leader aggregates votes
		}

		// Keep vote buckets isolated by phase and node so PREPARE/PRE-COMMIT/COMMIT votes
		// for the same block do not collide during duplicate checks and quorum counting.
		const voteBucketKey = `${vote.voteType}:${vote.nodeHash}`;
		const votesForNode = this.leaderState.pendingVotes.get(voteBucketKey) ?? [];
		if (votesForNode.some((v) => v.senderId === vote.senderId)) {
			return; // Ignore duplicates from the same sender
		}

		votesForNode.push(vote);
		this.leaderState.pendingVotes.set(voteBucketKey, votesForNode);

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

		// Phase transition: PREPARE quorum forms prepareQC and triggers PRE-COMMIT broadcast.
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
			return;
		}

		// Phase transition: PRE-COMMIT quorum forms precommitQC and triggers COMMIT broadcast.
		if (vote.voteType === MessageKind.PreCommit) {
			const commit: CommitMessage = {
				type: MessageKind.Commit,
				viewNumber: vote.viewNumber,
				senderId: this.id,
				nodeHash: vote.nodeHash,
				justify: qc,
			};

			for (const node of nodes) {
				if (node.id === this.id) {
					// Leader participates in the COMMIT phase immediately.
					await this.handleCommitMessage(commit, nodes);
					continue;
				}
				node.message(commit);
			}

			this.log(LogLevel.Info, `Broadcast COMMIT for ${vote.nodeHash} with QC.`);
			return;
		}

		// Phase transition: COMMIT quorum forms commitQC and triggers DECIDE broadcast.
		if (vote.voteType === MessageKind.Commit) {
			const decide: DecideMessage = {
				type: MessageKind.Decide,
				viewNumber: vote.viewNumber,
				senderId: this.id,
				nodeHash: vote.nodeHash,
				justify: qc,
			};

			for (const node of nodes) {
				if (node.id === this.id) {
					// Leader also finalizes locally when commitQC is formed.
					await this.handleDecideMessage(decide, nodes);
					continue;
				}
				node.message(decide);
			}

			this.log(LogLevel.Info, `Broadcast DECIDE for ${vote.nodeHash} with QC.`);
		}
	}

	/** Wrapper around the configured logger to centralize logging. */
	private log(level: LogLevel, message: string) {
		this.config.logger?.(level, this.id, message);
	}
}

/** Pseudo hash for blocks; sufficient for simulation/visualization. */
function blockHash(id: number, view: number, parentHash: string, data: unknown): string {
	const raw = `${id}:${view}:${parentHash}:${JSON.stringify(data)}`;
	return `b-${raw.length}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Synthetic genesis QC used when no prior certificates exist. */
function genesisQC(): QuorumCertificate {
	return {
		type: MessageKind.NewView,
		viewNumber: 0,
		nodeHash: "GENESIS",
		thresholdSig: "GENESIS_SIG",
	};
}
