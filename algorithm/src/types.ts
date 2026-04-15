// Core protocol data model shared across the simulator (blocks, QCs, wire messages, and node state snapshots).
/**
 * Aggregated quorum proof over a protocol statement (phase, view, and node hash).
 * In real HotStuff this is a threshold signature assembled from 2f+1 replica votes.
 */
export interface QuorumCertificate {
	type: MessageKind;
	viewNumber: number;
	nodeHash: string;
	thresholdSig: string;
}

/**
 * Minimal block payload tracked by the simulator's HotStuff tree.
 * Each block references its parent and stores opaque command data.
 */
export interface Block {
	hash: string;
	parentHash: string;
	data: unknown;
	height: number;
}

/**
 * Proposal wrapper sent during PREPARE.
 * Contains the candidate block and the QC (`justify`) used to prove it is safe to extend.
 */
export interface ProposalNode {
	block: Block;
	parentHash: string;
	justify: QuorumCertificate; // highQC from leader's collected NEW-VIEW messages
}

/**
 * HotStuff wire-level message categories used by this simulator.
 * Numeric enum values are sufficient because messages are exchanged in-memory.
 */
export enum MessageKind {
	Prepare,
	PreCommit,
	Commit,
	Decide,
	NewView,
	Vote,
}

/**
 * Common metadata present in every protocol message.
 * `viewNumber` tracks logical time; `senderId` identifies message origin.
 */
export interface BaseMessage {
	type: MessageKind;
	viewNumber: number;
	senderId: number;
}

/**
 * Leader proposal for the PREPARE phase.
 * Followers validate safety and reply with PREPARE votes when accepted.
 */
export interface PrepareMessage extends BaseMessage {
	type: MessageKind.Prepare;
	node: ProposalNode;
}

/**
 * Leader broadcast for PRE-COMMIT carrying the prepareQC for a specific node.
 */
export interface PreCommitMessage extends BaseMessage {
	type: MessageKind.PreCommit;
	nodeHash: string;
	justify: QuorumCertificate;
}

/**
 * Leader broadcast for COMMIT carrying the precommitQC.
 */
export interface CommitMessage extends BaseMessage {
	type: MessageKind.Commit;
	nodeHash: string;
	justify: QuorumCertificate;
}

/**
 * Finalization message indicating the node can be executed/considered decided.
 */
export interface DecideMessage extends BaseMessage {
	type: MessageKind.Decide;
	nodeHash: string;
	justify: QuorumCertificate; // commitQC
}

/**
 * Replica vote message used in PREPARE/PRE-COMMIT/COMMIT aggregation.
 * `partialSig` represents the replica's contribution to a future QC.
 */
export interface VoteMessage extends BaseMessage {
	type: MessageKind.Vote;
	voteType: MessageKind.Prepare | MessageKind.PreCommit | MessageKind.Commit;
	nodeHash: string;
	partialSig: string;
}

/**
 * View-change signal sent to the next leader.
 * Carries the sender's highest lock/QC evidence for safe proposal selection.
 */
export interface NewViewMessage extends BaseMessage {
	type: MessageKind.NewView;
	lockedQC: QuorumCertificate;
	partialSig: string;
}

/**
 * Union of every protocol message shape that can appear in a node's message queue.
 */
export type HotStuffMessage =
	| PrepareMessage
	| PreCommitMessage
	| CommitMessage
	| DecideMessage
	| VoteMessage
	| NewViewMessage;

// Local replica bookkeeping used by both leaders and followers inside the simulation loop.
/**
 * Per-replica consensus state required for safety and progress.
 * Includes current view, lock, highest prepareQC, and committed block history.
 */
export interface ReplicaState {
	id: number;
	viewNumber: number;
	lockedQC: QuorumCertificate | null;
	prepareQC: QuorumCertificate | null;
	committedBlocks: Block[];
}

/**
 * Leader-specific extension of replica state.
 * Tracks votes and NEW-VIEW messages needed to build QCs and advance phases.
 */
export interface LeaderState extends ReplicaState {
	// Pending votes keyed by the proposed node hash.
	pendingVotes: Map<string, VoteMessage[]>;
	collectedNewViews: NewViewMessage[];
}

/**
 * Log severity levels consumed by the injectable node logger.
 */
export enum LogLevel {
	Info = "INFO",
	Warning = "WARNING",
	Error = "ERROR",
}

/**
 * Startup failure modes returned by `run` when node preconditions are invalid.
 */
export enum FailState {
	NoNodesDefined,
	NodeSizeConfigMismatch,
	InvalidSystemModelSize,
}
