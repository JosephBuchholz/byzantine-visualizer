export interface QuorumCertificate {
	type: MessageKind;
	viewNumber: number;
	nodeHash: string;
	thresholdSig: string;
}

export interface Block {
	hash: string;
	parentHash: string;
	data: unknown;
	height: number;
}

export interface ProposalNode {
	block: Block;
	parentHash: string;
	justify: QuorumCertificate; // highQC from leader's collected NEW-VIEW messages
}

export enum MessageKind {
	Prepare,
	PreCommit,
	Commit,
	Decide,
	NewView,
	Vote,
}

export interface BaseMessage {
	type: MessageKind;
	viewNumber: number;
	senderId: number;
}

export interface PrepareMessage extends BaseMessage {
	type: MessageKind.Prepare;
	node: ProposalNode;
}

export interface PreCommitMessage extends BaseMessage {
	type: MessageKind.PreCommit;
	nodeHash: string;
	justify: QuorumCertificate;
}

export interface CommitMessage extends BaseMessage {
	type: MessageKind.Commit;
	nodeHash: string;
	justify: QuorumCertificate;
}

export interface DecideMessage extends BaseMessage {
	type: MessageKind.Decide;
	nodeHash: string;
	justify: QuorumCertificate; // commitQC
}

export interface VoteMessage extends BaseMessage {
	type: MessageKind.Vote;
	voteType: MessageKind.Prepare | MessageKind.PreCommit | MessageKind.Commit;
	nodeHash: string;
	partialSig: string;
}

export interface NewViewMessage extends BaseMessage {
	type: MessageKind.NewView;
	lockedQC: QuorumCertificate;
	partialSig: string;
}

export type HotStuffMessage =
	| PrepareMessage
	| PreCommitMessage
	| CommitMessage
	| DecideMessage
	| VoteMessage
	| NewViewMessage;

export interface ReplicaState {
	id: number;
	viewNumber: number;
	lockedQC: QuorumCertificate | null;
	prepareQC: QuorumCertificate | null;
	committedBlocks: Block[];
}

export interface LeaderState extends ReplicaState {
	pendingVotes: Map<number, VoteMessage[]>;
	collectedNewViews: NewViewMessage[];
}

export enum LogLevel {
	Info = "INFO",
	Warning = "WARNING",
	Error = "ERROR",
}

export enum FailState {
	NoNodesDefined,
	NodeSizeConfigMismatch,
}
