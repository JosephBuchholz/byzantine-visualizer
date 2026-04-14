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

interface PendingOperation {
	key: string;
	value: string | null;
	resolve: () => void;
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
	pendingOperations: PendingOperation[] = [];
	knownBlocksByHash: Map<string, Block> = new Map();
	lastWriteBatch: WriteBatch | null = null;
	leaderState: LeaderState | null = null;
	stepsWithoutProgress = 0;
	timeoutBackoffExponent = 0;
	suppressTimeoutForView: number | null = null;
	// vheight-style local voting memory: highest view this replica has voted PREPARE in.
	// This enforces monotonic voting and blocks stale re-votes.
	prepareVoteView = -1;
	// Tracks which proposal hash this replica already voted for in prepareVoteView.
	// This prevents conflicting votes inside the same view.
	prepareVoteNodeHash: string | null = null;

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
		// Keep proposal state up to date with the latest intent for this key.
		this.pendingWrites.set(key, value);

		// Resolve this API call only after DECIDE executes the matching committed write.
		// Tracking is local so a follower request can stay pending through forward/propose phases.
		return new Promise<void>((resolve) => {
			this.pendingOperations.push({ key, value, resolve });
		});
	}

	/**
	 * Queue a client delete operation for consensus.
	 * A null value marks deletion and follows the same batching/proposal path as writes.
	 */
	async delete(key: string): Promise<void> {
		// Represent delete as null in the proposal path so consensus carries explicit tombstones.
		this.pendingWrites.set(key, null);

		// Resolve this API call only after DECIDE executes the matching committed delete.
		return new Promise<void>((resolve) => {
			this.pendingOperations.push({ key, value: null, resolve });
		});
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

		// First ensure the provided runtime node array matches declared config size.
		// This existing guard should run before model-shape validation so caller mistakes
		// are reported as a simple size mismatch.
		if (nodes.length !== this.config.numNodes) {
			this.log(LogLevel.Error, `Expected ${this.config.numNodes} nodes, but got ${nodes.length}.`);
			return Result.err(FailState.NodeSizeConfigMismatch);
		}

		// Enforce Basic HotStuff system model: n must satisfy n = 3f + 1 for some integer f >= 0.
		// Equivalent arithmetic check: n % 3 === 1 with n >= 1.
		if (!this.isValidHotStuffSystemSize(this.config.numNodes)) {
			this.log(
				LogLevel.Error,
				`Invalid system size n=${this.config.numNodes}. Basic HotStuff requires n = 3f + 1.`,
			);
			return Result.err(FailState.InvalidSystemModelSize);
		}

		// Initialize role based on the current view before entering the run loop.
		// This keeps startup behavior aligned with the deterministic leader function.
		this.syncLeaderRole(nodes);

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
		// Re-evaluate leader/follower role at the start of every step.
		// This ensures leadership tracks view changes over time, not just startup.
		this.syncLeaderRole(nodes);

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

		// Messages handled above may have changed this node's view (e.g., DECIDE or timeout).
		// Re-sync role again so the remainder of this step uses the correct leader/follower path.
		this.syncLeaderRole(nodes);

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

			// Forward pending writes to leader
			for (const [key, value] of this.pendingWrites.entries()) {
				// Forward semantics are based on explicit null, not truthiness.
				// This preserves valid empty-string writes ("") as writes instead of misclassifying
				// them as deletes, which keeps visualization state faithful to client intent.
				if (value === null) {
					// Do not await commit-aware completion here: forwarding should only enqueue work
					// on the leader and return immediately so the simulation loop cannot deadlock.
					void leader.delete(key);
					continue;
				}

				// Do not await commit-aware completion here for the same reason as above.
				// The caller's own completion promise resolves later when DECIDE executes locally.
				void leader.put(key, value);
			}

			// Remove locally queued writes after forwarding to avoid duplicate re-forwarding
			// on subsequent idle steps in the same view.
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
			// Derive visual/tree height from the parent chain, not commit count.
			// This keeps block geometry correct for uncommitted and forked branches.
			height: this.computeChildHeightFromParent(parentHash),
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
	 * Compute the height for a newly proposed child block from its selected parent hash.
	 *
	 * Rules:
	 * 1) If parent is GENESIS, this is the first layer and child height is 1.
	 * 2) If parent exists locally, child height is parent.height + 1.
	 * 3) If parent is unexpectedly missing, fall back to 1 to keep simulation progress
	 *    safe while logging a warning for visibility.
	 */
	private computeChildHeightFromParent(parentHash: string): number {
		// Genesis proposals always start the tree at height 1.
		if (parentHash === "GENESIS") {
			return 1;
		}

		// For non-genesis proposals, recover parent height from the known local block tree.
		const parentBlock = this.knownBlocksByHash.get(parentHash);
		if (parentBlock) {
			return parentBlock.height + 1;
		}

		// Missing ancestry should be rare, but fallback avoids crashing the simulation loop.
		// We still emit a warning so this state is discoverable during debugging/testing.
		this.log(
			LogLevel.Warning,
			`Parent block ${parentHash} not found while proposing; defaulting child height to 1.`,
		);
		return 1;
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

	/**
	 * Validate that an incoming phase message was sent by the deterministic leader
	 * for the message's view number.
	 */
	private isMessageFromExpectedLeader(
		nodes: readonly Readonly<HotStuffNode>[],
		viewNumber: number,
		senderId: number,
		phaseName: string,
		nodeHash: string,
	): boolean {
		// Compute the only valid sender for this phase message from deterministic leadership.
		const expectedLeader = this.findLeaderForView(nodes, viewNumber);

		// Reject messages sent by non-leaders or stale leaders from prior views.
		if (senderId !== expectedLeader.id) {
			this.log(
				LogLevel.Warning,
				`Rejected ${phaseName} for ${nodeHash}: sender ${senderId} is not leader ${expectedLeader.id} for view ${viewNumber}.`,
			);
			return false;
		}

		return true;
	}

	/** Convenience check: is this node the current leader? */
	isLeader(nodes: readonly Readonly<HotStuffNode>[]): boolean {
		return this.id === this.findLeader(nodes).id;
	}

	/**
	 * Keep leader-only runtime state synchronized with deterministic leadership.
	 * - If this node is the current view leader, ensure leader state exists.
	 * - If this node is not the leader, drop leader-only state and act as follower.
	 */
	private syncLeaderRole(nodes: readonly Readonly<HotStuffNode>[]): void {
		const shouldBeLeader = this.isLeader(nodes);

		if (shouldBeLeader) {
			if (this.leaderState) {
				// Keep mirrored leader view aligned with replica view as views advance.
				this.leaderState.viewNumber = this.replicaState.viewNumber;
				return;
			}

			// Promote this node into leader mode for the current view.
			this.leaderState = {
				...this.replicaState,
				pendingVotes: new Map(),
				collectedNewViews: [],
			};
			this.log(LogLevel.Info, `Became leader for view ${this.replicaState.viewNumber}.`);
			return;
		}

		if (!this.leaderState) {
			return;
		}

		// Demote this node when it no longer matches the deterministic view leader.
		this.leaderState = null;
		this.log(
			LogLevel.Info,
			`Stepped down from leader role at view ${this.replicaState.viewNumber}.`,
		);
	}

	/** Compute the 2f+1 quorum threshold for vote aggregation. */
	private quorumSize(): number {
		// Quorum rule: need 2f+1 = floor(2n/3)+1 votes to form a QC.
		return Math.floor((this.config.numNodes * 2) / 3) + 1;
	}

	/**
	 * Validate that replica count matches the Basic HotStuff fault model shape n = 3f + 1.
	 *
	 * Why this exists:
	 * - Quorum math and safety/liveness reasoning assume this exact family of sizes.
	 * - Rejecting invalid n values avoids misleading "valid" simulator runs.
	 */
	private isValidHotStuffSystemSize(numNodes: number): boolean {
		// Defensive lower bound: model requires at least one replica.
		if (numNodes < 1) {
			return false;
		}

		// Arithmetic form of n = 3f + 1: exactly numbers congruent to 1 modulo 3.
		return numNodes % 3 === 1;
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

		const hasSelfEvidence = true;
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
		// Reject stale PREPARE messages from older views before any validation or state mutation.
		// This preserves monotonic view progress and prevents delayed packets from rewinding safety state.
		if (message.viewNumber < this.replicaState.viewNumber) {
			this.log(
				LogLevel.Warning,
				`Rejected PREPARE for ${message.node.block.hash}: stale view ${message.viewNumber} < local ${this.replicaState.viewNumber}.`,
			);
			return;
		}

		// Enforce leader-per-view rule: only the deterministic leader for this view can propose.
		if (
			!this.isMessageFromExpectedLeader(
				nodes,
				message.viewNumber,
				message.senderId,
				"PREPARE",
				message.node.block.hash,
			)
		) {
			return;
		}

		// Reject stale PREPARE messages from older views than our current local view.
		// This keeps local voting monotonic in time and avoids regressing protocol progress.
		if (message.viewNumber < this.replicaState.viewNumber) {
			this.log(
				LogLevel.Warning,
				`Rejected PREPARE for ${message.node.block.hash}: stale view ${message.viewNumber} < local ${this.replicaState.viewNumber}.`,
			);
			return;
		}

		// If we already voted in a newer view, never vote again for an older one.
		// This is the core vheight-style monotonic guard across views.
		if (message.viewNumber < this.prepareVoteView) {
			this.log(
				LogLevel.Warning,
				`Rejected PREPARE for ${message.node.block.hash}: already voted in newer view ${this.prepareVoteView}.`,
			);
			return;
		}

		// If we already voted in this exact view:
		// - same proposal hash: ignore duplicate delivery (idempotent)
		// - different proposal hash: reject conflicting second vote
		if (message.viewNumber === this.prepareVoteView) {
			if (this.prepareVoteNodeHash === message.node.block.hash) {
				this.log(
					LogLevel.Info,
					`Ignored duplicate PREPARE for ${message.node.block.hash} in view ${message.viewNumber}.`,
				);
				return;
			}

			this.log(
				LogLevel.Warning,
				`Rejected PREPARE for ${message.node.block.hash}: conflicting vote already cast for ${this.prepareVoteNodeHash} in view ${message.viewNumber}.`,
			);
			return;
		}

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

		// Record the local PREPARE vote decision before sending.
		// This prevents duplicate/conflicting votes if similar messages arrive immediately after.
		this.prepareVoteView = message.viewNumber;
		this.prepareVoteNodeHash = message.node.block.hash;

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
		// Reject stale PRE-COMMIT messages from older views before touching prepareQC.
		// Without this guard, delayed messages could overwrite newer prepare evidence.
		if (message.viewNumber < this.replicaState.viewNumber) {
			this.log(
				LogLevel.Warning,
				`Rejected PRE-COMMIT for ${message.nodeHash}: stale view ${message.viewNumber} < local ${this.replicaState.viewNumber}.`,
			);
			return;
		}

		// Enforce leader-per-view rule: PRE-COMMIT must come from current view leader.
		if (
			!this.isMessageFromExpectedLeader(
				nodes,
				message.viewNumber,
				message.senderId,
				"PRE-COMMIT",
				message.nodeHash,
			)
		) {
			return;
		}

		// Reject malformed PRE-COMMIT evidence where the carried QC does not certify the target node.
		if (message.justify.nodeHash !== message.nodeHash) {
			this.log(LogLevel.Warning, `Rejected PRE-COMMIT for ${message.nodeHash}: QC mismatch.`);
			return;
		}

		// Accept the PRE-COMMIT evidence as the highest known prepareQC and advance local view.
		// Adopt the leader's prepareQC as our highest seen and advance view.
		this.replicaState.prepareQC = message.justify;
		this.replicaState.viewNumber = Math.max(this.replicaState.viewNumber, message.viewNumber);

		// Emit a PRE-COMMIT vote back to the validated phase leader from the incoming message.
		const leader = this.findNodeById(nodes, message.senderId);
		if (!leader) {
			this.log(LogLevel.Error, `Cannot find leader ${message.senderId} to send PRE-COMMIT vote.`);
			return;
		}
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
		// Reject stale COMMIT messages from older views before touching lockedQC.
		// This protects the lock from being replaced by delayed precommit evidence.
		if (message.viewNumber < this.replicaState.viewNumber) {
			this.log(
				LogLevel.Warning,
				`Rejected COMMIT for ${message.nodeHash}: stale view ${message.viewNumber} < local ${this.replicaState.viewNumber}.`,
			);
			return;
		}

		// Enforce leader-per-view rule: COMMIT must come from current view leader.
		if (
			!this.isMessageFromExpectedLeader(
				nodes,
				message.viewNumber,
				message.senderId,
				"COMMIT",
				message.nodeHash,
			)
		) {
			return;
		}

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
		// Reject stale DECIDE messages from older views before execution or view transition.
		// This ensures finalized execution only follows the replica's current or newer view timeline.
		if (message.viewNumber < this.replicaState.viewNumber) {
			this.log(
				LogLevel.Warning,
				`Rejected DECIDE for ${message.nodeHash}: stale view ${message.viewNumber} < local ${this.replicaState.viewNumber}.`,
			);
			return;
		}

		// Enforce leader-per-view rule: DECIDE must come from current view leader.
		if (
			!this.isMessageFromExpectedLeader(
				nodes,
				message.viewNumber,
				message.senderId,
				"DECIDE",
				message.nodeHash,
			)
		) {
			return;
		}

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
					// Complete exactly one matching delete operation now that consensus executed it.
					this.resolveCommittedOperation(write.key, null);
					this.pendingWrites.delete(write.key);
					continue;
				}
				await this.dataStore.put(write.key, write.value);
				// Complete exactly one matching write operation now that consensus executed it.
				this.resolveCommittedOperation(write.key, write.value);
				this.pendingWrites.delete(write.key);
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
	 * Resolve the earliest pending client operation that matches an executed committed write.
	 * Matching by both key and value prevents resolving unrelated operations on the same key.
	 */
	private resolveCommittedOperation(key: string, value: string | null): void {
		// Use first-match order so repeated identical operations settle in submission order.
		const operationIndex = this.pendingOperations.findIndex(
			(operation) => operation.key === key && operation.value === value,
		);
		if (operationIndex < 0) {
			return;
		}

		const [operation] = this.pendingOperations.splice(operationIndex, 1);
		operation?.resolve();
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
