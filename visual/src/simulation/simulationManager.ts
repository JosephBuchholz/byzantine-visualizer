import { defineNode, type HotStuffNode } from "../../../algorithm/src/index.ts";
import {
  LogLevel,
  MessageKind,
  type HotStuffMessage,
  type VoteMessage,
} from "../../../algorithm/src/types.ts";
import SimMessage, { CLIENT_ID } from "./SimMessage";

const BASE_LOOP_TIMEOUT_MS = 12;
const BASE_LEADER_TIMEOUT_STEPS = 8;
const BASE_BATCH_WAIT_MS = 120;

export type ReplicaType = "default" | "adversary";

export class SimReplica {
  id: string;
  type: ReplicaType;
  isLeader: boolean;

  constructor(id: string, type: ReplicaType, isLeader = false) {
    this.id = id;
    this.type = type;
    this.isLeader = isLeader;
  }
}

export interface PhaseUpdate {
  phase: string;
  detail: string;
  steps: string[];
  processedCommands?: string[];
}

export type ProtocolPathMode = "healthy" | "recovery" | "funny";

export interface ProtocolPathUpdate {
  mode: ProtocolPathMode;
  title: string;
  detail: string;
  recentEvents: string[];
}

interface VisualStep {
  phaseUpdate: PhaseUpdate;
  messages: SimMessage[];
}

interface PrepareBroadcastBatch {
  senderId: string;
  view: number;
  messagesByReceiver: Map<string, SimMessage>;
}

interface PrepareVoteBatch {
  receiverId: string;
  view: number;
  messagesBySender: Map<string, SimMessage>;
}

interface PreCommitBroadcastBatch {
  senderId: string;
  view: number;
  messagesByReceiver: Map<string, SimMessage>;
}

interface PreCommitVoteBatch {
  receiverId: string;
  view: number;
  messagesBySender: Map<string, SimMessage>;
}

interface CommitBroadcastBatch {
  senderId: string;
  view: number;
  messagesByReceiver: Map<string, SimMessage>;
}

interface CommitVoteBatch {
  receiverId: string;
  view: number;
  messagesBySender: Map<string, SimMessage>;
}

interface DecideBroadcastBatch {
  senderId: string;
  view: number;
  messagesByReceiver: Map<string, SimMessage>;
}

interface NewViewBatch {
  receiverId: string;
  view: number;
  messagesBySender: Map<string, SimMessage>;
}

type SteppableNode = HotStuffNode & {
  step: (nodes: readonly Readonly<HotStuffNode>[]) => Promise<void>;
  isLeader: (nodes: readonly Readonly<HotStuffNode>[]) => boolean;
};

export default class SimulationManager {
  private onNewReplicaCallback: ((replica: SimReplica) => void) | null;
  private onRemoveReplicaCallback: ((replicaID: string) => void) | null;
  private onSendMessageCallback: ((message: SimMessage) => void) | null;
  private onPhaseChangeCallback: ((update: PhaseUpdate) => void) | null;
  private onProtocolPathCallback: ((update: ProtocolPathUpdate) => void) | null;

  private replicas: Map<string, SimReplica>;
  private nodes: SteppableNode[];
  private numReplicas: number;
  private numFaults: number;
  private faultyNodeIndices: Set<number>;
  private clusterConfigured: boolean;
  private simulationStarted: boolean;
  private stepping: boolean;
  private clientWriteCounter: number;
  private faultyStepEpoch: number;
  private currentViewNumber: number;
  private pendingDecideCommands: string[];
  private processedCommands: string[];
  private protocolPathMode: ProtocolPathMode;
  private protocolPathTitle: string;
  private protocolPathDetail: string;
  private protocolPathEvents: string[];
  private lastProtocolPathEvent: string;
  private injectedFaultyLeaderViews: Set<number>;

  private pendingVisualSteps: VisualStep[];
  private prepareBroadcastBatches: Map<string, PrepareBroadcastBatch>;
  private prepareVoteBatches: Map<string, PrepareVoteBatch>;
  private emittedPrepareBroadcastBatches: Set<string>;
  private emittedPrepareVoteBatches: Set<string>;
  private preCommitBroadcastBatches: Map<string, PreCommitBroadcastBatch>;
  private preCommitVoteBatches: Map<string, PreCommitVoteBatch>;
  private emittedPreCommitBroadcastBatches: Set<string>;
  private emittedPreCommitVoteBatches: Set<string>;
  private commitBroadcastBatches: Map<string, CommitBroadcastBatch>;
  private commitVoteBatches: Map<string, CommitVoteBatch>;
  private emittedCommitBroadcastBatches: Set<string>;
  private emittedCommitVoteBatches: Set<string>;
  private decideBroadcastBatches: Map<string, DecideBroadcastBatch>;
  private emittedDecideBroadcastBatches: Set<string>;
  private newViewBatches: Map<string, NewViewBatch>;
  private emittedNewViewBatches: Set<string>;
  private actionHistory: VisualStep[];
  private currentActionIndex: number;

  constructor() {
    this.onNewReplicaCallback = null;
    this.onRemoveReplicaCallback = null;
    this.onSendMessageCallback = null;
    this.onPhaseChangeCallback = null;
    this.onProtocolPathCallback = null;

    this.replicas = new Map();
    this.nodes = [];
    this.numReplicas = 1;
    this.numFaults = 0;
    this.faultyNodeIndices = new Set<number>();
    this.clusterConfigured = false;
    this.simulationStarted = false;
    this.stepping = false;
    this.clientWriteCounter = 0;
    this.faultyStepEpoch = 0;
    this.currentViewNumber = 0;
    this.pendingDecideCommands = [];
    this.processedCommands = [];
    this.protocolPathMode = "healthy";
    this.protocolPathTitle = "Healthy Path";
    this.protocolPathDetail = "Normal Basic HotStuff round progression.";
    this.protocolPathEvents = [];
    this.lastProtocolPathEvent = "";
    this.injectedFaultyLeaderViews = new Set();

    this.pendingVisualSteps = [];
    this.prepareBroadcastBatches = new Map();
    this.prepareVoteBatches = new Map();
    this.emittedPrepareBroadcastBatches = new Set();
    this.emittedPrepareVoteBatches = new Set();
    this.preCommitBroadcastBatches = new Map();
    this.preCommitVoteBatches = new Map();
    this.emittedPreCommitBroadcastBatches = new Set();
    this.emittedPreCommitVoteBatches = new Set();
    this.commitBroadcastBatches = new Map();
    this.commitVoteBatches = new Map();
    this.emittedCommitBroadcastBatches = new Set();
    this.emittedCommitVoteBatches = new Set();
    this.decideBroadcastBatches = new Map();
    this.emittedDecideBroadcastBatches = new Set();
    this.newViewBatches = new Map();
    this.emittedNewViewBatches = new Set();
    this.actionHistory = [];
    this.currentActionIndex = -1;
  }

  getNumReplicas(): number {
    return this.replicas.size;
  }

  configureCluster(numReplicas: number, numFaults: number) {
    this.numReplicas = Math.max(1, numReplicas);
    this.numFaults = Math.max(0, Math.min(numFaults, this.maxFaultsForReplicas(this.numReplicas)));
    this.rebuildCluster();
  }

  setSpeed(_speed: number) {
    // Speed only affects canvas animation; protocol advancement is manual per step.
    void _speed;
  }

  isSimulationStarted(): boolean {
    return this.simulationStarted;
  }

  canReplayCurrentAction(): boolean {
    return this.currentActionIndex >= 0 && this.currentActionIndex < this.actionHistory.length;
  }

  canGoToPreviousAction(): boolean {
    return this.currentActionIndex > 0;
  }

  replayCurrentAction(): boolean {
    if (!this.canReplayCurrentAction()) {
      return false;
    }

    this.renderStep(this.actionHistory[this.currentActionIndex] ?? null, false);
    return true;
  }

  goToPreviousAction(): boolean {
    if (!this.canGoToPreviousAction()) {
      return false;
    }

    this.currentActionIndex -= 1;
    this.renderStep(this.actionHistory[this.currentActionIndex] ?? null, false);
    return true;
  }

  async sendClientMessageAndRunFirstPhase(message: string): Promise<boolean> {
    if (!this.clusterConfigured) {
      this.rebuildCluster();
    }

    this.resetStepHistory(true);
    this.pendingDecideCommands.push(message);
    this.enqueueClientIngressSteps(message);
    this.submitClientWriteToAllReplicas(message);
    this.setProtocolPath(
      "healthy",
      "Healthy Path",
      "Client request entered the current view pipeline.",
      `Client request submitted: ${message}`,
    );

    this.simulationStarted = true;
    return this.nextStep();
  }

  async nextStep(): Promise<boolean> {
    if (!this.simulationStarted || this.stepping || this.nodes.length === 0) {
      return false;
    }

    // If user navigated backward, step forward through recorded history first.
    if (this.currentActionIndex < this.actionHistory.length - 1) {
      this.currentActionIndex += 1;
      this.renderStep(this.actionHistory[this.currentActionIndex] ?? null, false);
      return true;
    }

    if (this.pendingVisualSteps.length === 0) {
      this.stepping = true;
      try {
        await this.generateNextVisualStep();
      } finally {
        this.stepping = false;
      }
    }

    const next = this.pendingVisualSteps.shift() ?? null;
    if (!next) {
      return false;
    }

    this.renderStep(next, true);
    return true;
  }

  dispose() {
    this.stepping = false;
  }

  setOnNewReplicaCallback(callback: (replica: SimReplica) => void) {
    this.onNewReplicaCallback = callback;
  }

  setOnRemoveReplicaCallback(callback: (replicaID: string) => void) {
    this.onRemoveReplicaCallback = callback;
  }

  setOnSendMessageCallback(callback: (message: SimMessage) => void) {
    this.onSendMessageCallback = callback;
  }

  setOnPhaseChangeCallback(callback: (update: PhaseUpdate) => void) {
    this.onPhaseChangeCallback = callback;
  }

  setOnProtocolPathCallback(callback: (update: ProtocolPathUpdate) => void) {
    this.onProtocolPathCallback = callback;
    this.onProtocolPathCallback?.({
      mode: this.protocolPathMode,
      title: this.protocolPathTitle,
      detail: this.protocolPathDetail,
      recentEvents: [...this.protocolPathEvents],
    });
  }

  private enqueueClientIngressSteps(message: string) {
    const leaderId = this.toNodeId(this.currentLeaderIndex());
    const replicaIds = Array.from(this.replicas.keys());
    const ingressMessages = replicaIds.map((replicaId) => new SimMessage("CLIENT REQUEST", CLIENT_ID, replicaId));

    // Emit a single visual step containing all client -> replica messages simultaneously.
    this.pendingVisualSteps.push({
      phaseUpdate: {
        phase: "Client Broadcast",
        detail: `Client broadcasts the same request to all ${replicaIds.length} replicas at once.`,
        steps: [
          `Sender: ${CLIENT_ID}`,
          `Receivers: ${replicaIds.join(", ")}`,
          `Current leader in this view: ${leaderId}`,
          `Payload: client request value = "${message}"`,
          "Purpose: client broadcast. Any replica can receive and ensure the request reaches the leader path.",
        ],
      },
      messages: ingressMessages.map((m) => new SimMessage(m.content, m.fromID, m.toID)),
    });
  }

  private submitClientWriteToAllReplicas(message: string) {
    const key = `client-${this.clientWriteCounter}`;
    this.clientWriteCounter += 1;

    for (let index = 0; index < this.nodes.length; index++) {
      const targetNode = this.nodes[index];
      if (!targetNode) {
        continue;
      }

      void targetNode.put(key, message).catch((error) => {
        console.error(`Failed to submit client message for node-${index}:`, error);
      });
    }
  }

  private async generateNextVisualStep() {
    const maxTicks = 800;
    for (let i = 0; i < maxTicks && this.pendingVisualSteps.length === 0; i++) {
      await this.processOneTick();
    }
  }

  private async processOneTick() {
    this.faultyStepEpoch += 1;
    const leaderIndex = this.currentLeaderIndex();
    const leaderIsFaulty = this.isFaultyNode(leaderIndex);
    const activeView = this.currentViewNumber;

    for (let index = 0; index < this.nodes.length; index++) {
      const node = this.nodes[index];
      if (!node) {
        continue;
      }

      // Faulty-leader scenario (documented Path 3 Case B): simulate a silent faulty leader.
      // Recovery is handled by the existing backend timeout -> NEW-VIEW logic.
      if (leaderIsFaulty && index === leaderIndex) {
        if (!this.injectedFaultyLeaderViews.has(activeView)) {
          this.injectedFaultyLeaderViews.add(activeView);
          this.setProtocolPath(
            "funny",
            "Funny Business Detected",
            "Faulty leader is silent in this view. Waiting for timeout-driven recovery.",
            `View ${activeView}: faulty leader ${this.toNodeId(leaderIndex)} withheld progress.`,
          );
        }
        continue;
      }

      if (this.isFaultyNode(index) && !this.shouldFaultyNodeAct(index)) {
        continue;
      }

      await node.step(this.nodes);
      if (this.pendingVisualSteps.length > 0) {
        return;
      }
    }
  }

  private rebuildCluster() {
    this.clearVisualReplicas();
    this.faultyNodeIndices = this.pickRandomFaultyIndices(this.numReplicas, this.numFaults);
    this.currentViewNumber = 0;
    this.injectedFaultyLeaderViews.clear();
    this.setProtocolPath(
      "healthy",
      "Healthy Path",
      "Cluster initialized. Waiting for client input.",
      "Simulation initialized.",
    );

    this.nodes = [];
    for (let nodeIndex = 0; nodeIndex < this.numReplicas; nodeIndex++) {
      const node = defineNode(nodeIndex, {
        numNodes: this.numReplicas,
        loopTimeoutMaxMs: BASE_LOOP_TIMEOUT_MS,
        leaderTimeoutMaxMs: BASE_LEADER_TIMEOUT_STEPS,
        maxBatchSize: 1,
        maxBatchWaitTimeMs: BASE_BATCH_WAIT_MS,
        logger: (level, id, logMessage) => this.handleBackendLog(level, id, logMessage),
      }) as SteppableNode;

      this.patchNodeMessageTap(node);
      this.nodes.push(node);
    }

    this.refreshReplicaTypes();
    this.clusterConfigured = true;
    this.simulationStarted = false;
    this.resetStepHistory();
    this.onPhaseChangeCallback?.({
      phase: "Ready",
      detail: "Set up the simulation, then step through one protocol message at a time.",
      steps: [
        "Choose Number of Replicas and Number of Faults.",
        "Enter a client message and click Send Message.",
        "Click Next Step to animate one message transition.",
        "Read Current Step Action to understand the exact sender, receiver, and purpose.",
      ],
    });
  }

  private refreshReplicaTypes() {
    this.clearVisualReplicas();

    const leaderIndex = this.currentLeaderIndex();
    for (let nodeIndex = 0; nodeIndex < this.numReplicas; nodeIndex++) {
      const replica = new SimReplica(
        this.toNodeId(nodeIndex),
        this.replicaTypeForNode(nodeIndex),
        nodeIndex === leaderIndex,
      );
      this.replicas.set(replica.id, replica);
      this.onNewReplicaCallback?.(replica);
    }
  }

  private clearVisualReplicas() {
    for (const replicaID of this.replicas.keys()) {
      this.onRemoveReplicaCallback?.(replicaID);
    }
    this.replicas.clear();
  }

  private patchNodeMessageTap(node: SteppableNode) {
    const originalMessage = node.message.bind(node);
    node.message = (message: HotStuffMessage) => {
      this.enqueueProtocolVisualStep(message, node.id);
      originalMessage(message);
    };
  }

  private enqueueProtocolVisualStep(message: HotStuffMessage, recipientNodeId: number) {
    const senderId = this.toNodeId(message.senderId);
    const receiverId = this.toNodeId(recipientNodeId);
    const simMessage = new SimMessage(this.messageLabel(message), senderId, receiverId);

    if (message.type === MessageKind.NewView) {
      const batchKey = `${recipientNodeId}:${message.viewNumber}`;
      if (this.emittedNewViewBatches.has(batchKey)) {
        return;
      }

      // Entering NEW-VIEW for v implies DECIDE for v-1 already completed/advanced.
      this.flushDecideBroadcastBatchesForView(message.viewNumber - 1);

      const existingBatch = this.newViewBatches.get(batchKey);
      const batch: NewViewBatch =
        existingBatch ??
        {
          receiverId,
          view: message.viewNumber,
          messagesBySender: new Map<string, SimMessage>(),
        };

      batch.messagesBySender.set(senderId, simMessage);
      this.newViewBatches.set(batchKey, batch);

      if (batch.messagesBySender.size >= this.numReplicas) {
        this.emitNewViewBatch(batch, batchKey);
      }

      return;
    }

    if (message.type === MessageKind.Prepare) {
      // PREPARE in this view implies NEW-VIEW quorum is complete; flush NEW-VIEW fan-in first.
      this.flushNewViewBatchesForView(message.viewNumber);

      const batchKey = `${message.senderId}:${message.viewNumber}`;
      if (this.emittedPrepareBroadcastBatches.has(batchKey)) {
        return;
      }
      const existingBatch = this.prepareBroadcastBatches.get(batchKey);
      const batch: PrepareBroadcastBatch =
        existingBatch ??
        {
          senderId,
          view: message.viewNumber,
          messagesByReceiver: new Map<string, SimMessage>(),
        };

      batch.messagesByReceiver.set(receiverId, simMessage);

      this.prepareBroadcastBatches.set(batchKey, batch);

      const expectedReceivers = Math.max(1, this.numReplicas - 1);
      if (batch.messagesByReceiver.size >= expectedReceivers) {
        if (!batch.messagesByReceiver.has(senderId)) {
          batch.messagesByReceiver.set(senderId, new SimMessage(this.messageLabel(message), senderId, senderId));
        }

        const orderedReceivers = Array.from(batch.messagesByReceiver.keys()).sort(
          (left, right) => this.nodeIndexFromId(left) - this.nodeIndexFromId(right),
        );
        const fanoutMessages = orderedReceivers
          .map((receiver) => batch.messagesByReceiver.get(receiver))
          .filter((candidate): candidate is SimMessage => Boolean(candidate));

        this.pendingVisualSteps.push({
          phaseUpdate: {
            phase: "Prepare",
            detail: `${senderId} sends PREPARE to all replicas (including itself) in view ${message.viewNumber}.`,
            steps: [
              `Sender: ${senderId} (leader for view ${message.viewNumber})`,
              `Receivers: ${orderedReceivers.join(", ")}`,
              "Leader self-send is shown as a short loop-back animation.",
              "Message: PREPARE with proposal node and justify QC",
              "Receiver action: validate parent linkage + safeNode, then vote PREPARE if valid.",
            ],
          },
          messages: fanoutMessages,
        });

        this.prepareBroadcastBatches.delete(batchKey);
        this.emittedPrepareBroadcastBatches.add(batchKey);
      }

      return;
    }

    if (message.type === MessageKind.Vote && message.voteType === MessageKind.Prepare) {
      const batchKey = `${recipientNodeId}:${message.viewNumber}:${MessageKind.Prepare}`;
      if (this.emittedPrepareVoteBatches.has(batchKey)) {
        return;
      }
      const existingBatch = this.prepareVoteBatches.get(batchKey);
      const batch: PrepareVoteBatch =
        existingBatch ??
        {
          receiverId,
          view: message.viewNumber,
          messagesBySender: new Map<string, SimMessage>(),
        };

      batch.messagesBySender.set(senderId, simMessage);
      this.prepareVoteBatches.set(batchKey, batch);

      const expectedFollowerVotes = Math.max(0, this.numReplicas - 1);
      if (batch.messagesBySender.size >= expectedFollowerVotes) {
        this.emitPrepareVoteBatch(batch);
        this.prepareVoteBatches.delete(batchKey);
        this.emittedPrepareVoteBatches.add(batchKey);
      }

      return;
    }

    if (message.type === MessageKind.PreCommit) {
      const batchKey = `${message.senderId}:${message.viewNumber}`;
      if (this.emittedPreCommitBroadcastBatches.has(batchKey)) {
        // Still flush prepare votes if we are clearly in pre-commit stage.
        this.flushPrepareVoteBatchesForView(message.viewNumber);
        return;
      }
      const existingBatch = this.preCommitBroadcastBatches.get(batchKey);
      const batch: PreCommitBroadcastBatch =
        existingBatch ??
        {
          senderId,
          view: message.viewNumber,
          messagesByReceiver: new Map<string, SimMessage>(),
        };

      batch.messagesByReceiver.set(receiverId, simMessage);
      this.preCommitBroadcastBatches.set(batchKey, batch);

      const expectedReceivers = Math.max(1, this.numReplicas - 1);
      if (batch.messagesByReceiver.size >= expectedReceivers) {
        this.emitPreCommitBroadcastBatch(batch);
        this.preCommitBroadcastBatches.delete(batchKey);
        this.emittedPreCommitBroadcastBatches.add(batchKey);
      }

      // If protocol already advanced to PRE-COMMIT broadcast, flush any remaining prepare-vote batch.
      this.flushPrepareVoteBatchesForView(message.viewNumber);
      return;
    }

    if (message.type === MessageKind.Vote && message.voteType === MessageKind.PreCommit) {
      const batchKey = `${recipientNodeId}:${message.viewNumber}:${MessageKind.PreCommit}`;
      if (this.emittedPreCommitVoteBatches.has(batchKey)) {
        return;
      }
      const existingBatch = this.preCommitVoteBatches.get(batchKey);
      const batch: PreCommitVoteBatch =
        existingBatch ??
        {
          receiverId,
          view: message.viewNumber,
          messagesBySender: new Map<string, SimMessage>(),
        };

      batch.messagesBySender.set(senderId, simMessage);
      this.preCommitVoteBatches.set(batchKey, batch);

      const expectedFollowerVotes = Math.max(0, this.numReplicas - 1);
      if (batch.messagesBySender.size >= expectedFollowerVotes) {
        this.emitPreCommitVoteBatch(batch);
        this.preCommitVoteBatches.delete(batchKey);
        this.emittedPreCommitVoteBatches.add(batchKey);
      }

      return;
    }

    if (message.type === MessageKind.Commit) {
      const batchKey = `${message.senderId}:${message.viewNumber}`;
      if (this.emittedCommitBroadcastBatches.has(batchKey)) {
        // Still flush pre-commit votes if we are clearly in commit stage.
        this.flushPreCommitVoteBatchesForView(message.viewNumber);
        return;
      }
      const existingBatch = this.commitBroadcastBatches.get(batchKey);
      const batch: CommitBroadcastBatch =
        existingBatch ??
        {
          senderId,
          view: message.viewNumber,
          messagesByReceiver: new Map<string, SimMessage>(),
        };

      batch.messagesByReceiver.set(receiverId, simMessage);
      this.commitBroadcastBatches.set(batchKey, batch);

      const expectedReceivers = Math.max(1, this.numReplicas - 1);
      if (batch.messagesByReceiver.size >= expectedReceivers) {
        this.emitCommitBroadcastBatch(batch);
        this.commitBroadcastBatches.delete(batchKey);
        this.emittedCommitBroadcastBatches.add(batchKey);
      }

      // If protocol already advanced to COMMIT broadcast, flush any remaining pre-commit vote batch.
      this.flushPreCommitVoteBatchesForView(message.viewNumber);
      return;
    }

    if (message.type === MessageKind.Vote && message.voteType === MessageKind.Commit) {
      const batchKey = `${recipientNodeId}:${message.viewNumber}:${MessageKind.Commit}`;
      if (this.emittedCommitVoteBatches.has(batchKey)) {
        return;
      }
      const existingBatch = this.commitVoteBatches.get(batchKey);
      const batch: CommitVoteBatch =
        existingBatch ??
        {
          receiverId,
          view: message.viewNumber,
          messagesBySender: new Map<string, SimMessage>(),
        };

      batch.messagesBySender.set(senderId, simMessage);
      this.commitVoteBatches.set(batchKey, batch);

      const expectedFollowerVotes = Math.max(0, this.numReplicas - 1);
      if (batch.messagesBySender.size >= expectedFollowerVotes) {
        this.emitCommitVoteBatch(batch);
        this.commitVoteBatches.delete(batchKey);
        this.emittedCommitVoteBatches.add(batchKey);
      }

      return;
    }

    if (message.type === MessageKind.Decide) {
      const batchKey = `${message.senderId}:${message.viewNumber}`;
      if (this.emittedDecideBroadcastBatches.has(batchKey)) {
        // Still flush commit votes if we are clearly in decide stage.
        this.flushCommitVoteBatchesForView(message.viewNumber);
        return;
      }
      const existingBatch = this.decideBroadcastBatches.get(batchKey);
      const batch: DecideBroadcastBatch =
        existingBatch ??
        {
          senderId,
          view: message.viewNumber,
          messagesByReceiver: new Map<string, SimMessage>(),
        };

      batch.messagesByReceiver.set(receiverId, simMessage);
      this.decideBroadcastBatches.set(batchKey, batch);

      const expectedReceivers = Math.max(1, this.numReplicas - 1);
      if (batch.messagesByReceiver.size >= expectedReceivers) {
        this.emitDecideBroadcastBatch(batch);
        this.decideBroadcastBatches.delete(batchKey);
        this.emittedDecideBroadcastBatches.add(batchKey);
      }

      // If protocol already advanced to DECIDE broadcast, flush any remaining commit vote batch.
      this.flushCommitVoteBatchesForView(message.viewNumber);
      return;
    }

    this.pendingVisualSteps.push({
      phaseUpdate: this.describeProtocolStep(message, senderId, receiverId),
      messages: [simMessage],
    });
  }

  private describeProtocolStep(
    message: HotStuffMessage,
    senderId: string,
    receiverId: string,
  ): PhaseUpdate {
    const view = message.viewNumber;

    if (message.type === MessageKind.Prepare) {
      return {
        phase: "Prepare",
        detail: `${senderId} sends PREPARE to ${receiverId} in view ${view}.`,
        steps: [
          `Sender: ${senderId} (leader for view ${view})`,
          `Receiver: ${receiverId}`,
          `Message: PREPARE with proposal node and justify QC`,
          "Receiver action: validate parent linkage + safeNode, then vote PREPARE if valid.",
        ],
      };
    }

    if (message.type === MessageKind.PreCommit) {
      return {
        phase: "Pre-Commit",
        detail: `${senderId} sends PRE-COMMIT to ${receiverId} in view ${view}.`,
        steps: [
          `Sender: ${senderId} (leader)`,
          `Receiver: ${receiverId}`,
          "Message: PRE-COMMIT carrying prepareQC",
          "Receiver action: store prepareQC and return VOTE-PRE-COMMIT.",
        ],
      };
    }

    if (message.type === MessageKind.Commit) {
      return {
        phase: "Commit",
        detail: `${senderId} sends COMMIT to ${receiverId} in view ${view}.`,
        steps: [
          `Sender: ${senderId} (leader)`,
          `Receiver: ${receiverId}`,
          "Message: COMMIT carrying precommitQC",
          "Receiver action: update lockedQC and return VOTE-COMMIT.",
        ],
      };
    }

    if (message.type === MessageKind.Decide) {
      return {
        phase: "Decide",
        detail: `${senderId} sends DECIDE to ${receiverId} in view ${view}.`,
        steps: [
          `Sender: ${senderId} (leader)`,
          `Receiver: ${receiverId}`,
          "Message: DECIDE carrying commitQC",
          "Receiver action: execute committed branch and advance to next view.",
        ],
      };
    }

    if (message.type === MessageKind.NewView) {
      return {
        phase: "New-View",
        detail: `${senderId} sends NEW-VIEW to ${receiverId} targeting view ${view}.`,
        steps: [
          `Sender: ${senderId}`,
          `Receiver: ${receiverId} (next-view leader)`,
          "Message: NEW-VIEW carrying highest known prepareQC",
          "Purpose: provide safety evidence so the next leader can choose highQC.",
        ],
      };
    }

    if (message.type === MessageKind.Vote) {
      const voteType = this.voteLabel((message as VoteMessage).voteType);
      return {
        phase: `${voteType} Vote`,
        detail: `${senderId} sends ${voteType} vote to ${receiverId} in view ${view}.`,
        steps: [
          `Sender: ${senderId}`,
          `Receiver: ${receiverId} (leader collecting quorum)`,
          `Message: VOTE-${voteType.toUpperCase()} partial signature`,
          `Purpose: help leader reach quorum (target ${this.quorumSize()} votes) and advance protocol stage.`,
        ],
      };
    }

    return {
      phase: "Protocol Message",
      detail: `${senderId} sent a protocol message to ${receiverId}.`,
      steps: [
        `Sender: ${senderId}`,
        `Receiver: ${receiverId}`,
        `View: ${view}`,
      ],
    };
  }

  private voteLabel(voteType: MessageKind): string {
    if (voteType === MessageKind.Prepare) {
      return "Prepare";
    }
    if (voteType === MessageKind.PreCommit) {
      return "Pre-Commit";
    }
    return "Commit";
  }

  private messageLabel(message: HotStuffMessage): string {
    const viewText = `v${message.viewNumber}`;
    switch (message.type) {
      case MessageKind.NewView:
        return `new-view ${viewText}`;
      case MessageKind.Prepare:
        return `prepare ${viewText}`;
      case MessageKind.PreCommit:
        return `pre-commit ${viewText}`;
      case MessageKind.Commit:
        return `commit ${viewText}`;
      case MessageKind.Decide:
        return `decide ${viewText}`;
      case MessageKind.Vote:
        if (message.voteType === MessageKind.Prepare) {
          return `vote-prepare ${viewText}`;
        }
        if (message.voteType === MessageKind.PreCommit) {
          return `vote-pre-commit ${viewText}`;
        }
        return `vote-commit ${viewText}`;
      default:
        return `message ${viewText}`;
    }
  }

  private handleBackendLog(level: LogLevel, _nodeId: number, logMessage: string) {
    if (level === LogLevel.Error) {
      console.error(logMessage);
      this.setProtocolPath(
        "funny",
        "Funny Business Detected",
        "Error path observed. Protocol safety checks are active.",
        logMessage,
      );
    }

    if (logMessage.includes("Rejected")) {
      this.setProtocolPath(
        "funny",
        "Funny Business Detected",
        "Replica rejected an invalid/conflicting protocol input.",
        logMessage,
      );
    }

    if (logMessage.includes("via timeout")) {
      this.setProtocolPath(
        "recovery",
        "View-Change Recovery",
        "Timeout path triggered. Replicas are recovering via NEW-VIEW.",
        logMessage,
      );
    }

    if (logMessage.includes("Decided block")) {
      this.setProtocolPath(
        "healthy",
        "Healthy Path",
        "Round completed and committed successfully.",
        logMessage,
      );
    }

    // Keep leader visualization in sync with view changes.
    if (logMessage.includes("Transitioned to view")) {
      const match = logMessage.match(/Transitioned to view\s+(\d+)/i);
      if (match?.[1]) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed)) {
          this.currentViewNumber = parsed;
        }
      }
      this.refreshReplicaTypes();
    }
  }

  private setProtocolPath(
    mode: ProtocolPathMode,
    title: string,
    detail: string,
    event?: string,
  ) {
    this.protocolPathMode = mode;
    this.protocolPathTitle = title;
    this.protocolPathDetail = detail;

    if (event && event !== this.lastProtocolPathEvent) {
      this.protocolPathEvents.push(event);
      if (this.protocolPathEvents.length > 6) {
        this.protocolPathEvents = this.protocolPathEvents.slice(-6);
      }
      this.lastProtocolPathEvent = event;
    }

    this.onProtocolPathCallback?.({
      mode: this.protocolPathMode,
      title: this.protocolPathTitle,
      detail: this.protocolPathDetail,
      recentEvents: [...this.protocolPathEvents],
    });
  }

  private renderStep(step: VisualStep | null, recordInHistory: boolean) {
    if (!step) {
      return;
    }

    this.onPhaseChangeCallback?.(step.phaseUpdate);
    for (const message of step.messages) {
      this.onSendMessageCallback?.(new SimMessage(message.content, message.fromID, message.toID));
    }

    // After a DECIDE round is visualized, pause stepping and wait for next client input.
    if (step.phaseUpdate.phase === "Decide") {
      this.simulationStarted = false;
    }

    if (!recordInHistory) {
      return;
    }

    if (this.currentActionIndex < this.actionHistory.length - 1) {
      this.actionHistory = this.actionHistory.slice(0, this.currentActionIndex + 1);
    }

    this.actionHistory.push({
      phaseUpdate: {
        phase: step.phaseUpdate.phase,
        detail: step.phaseUpdate.detail,
        steps: [...step.phaseUpdate.steps],
        processedCommands: step.phaseUpdate.processedCommands
          ? [...step.phaseUpdate.processedCommands]
          : undefined,
      },
      messages: step.messages.map((message) => new SimMessage(message.content, message.fromID, message.toID)),
    });
    this.currentActionIndex = this.actionHistory.length - 1;
  }

  private resetStepHistory(preserveProcessedCommands = false) {
    this.pendingVisualSteps = [];
    this.prepareBroadcastBatches.clear();
    this.prepareVoteBatches.clear();
    this.emittedPrepareBroadcastBatches.clear();
    this.emittedPrepareVoteBatches.clear();
    this.preCommitBroadcastBatches.clear();
    this.preCommitVoteBatches.clear();
    this.emittedPreCommitBroadcastBatches.clear();
    this.emittedPreCommitVoteBatches.clear();
    this.commitBroadcastBatches.clear();
    this.commitVoteBatches.clear();
    this.emittedCommitBroadcastBatches.clear();
    this.emittedCommitVoteBatches.clear();
    this.decideBroadcastBatches.clear();
    this.emittedDecideBroadcastBatches.clear();
    this.newViewBatches.clear();
    this.emittedNewViewBatches.clear();
    this.pendingDecideCommands = [];
    if (!preserveProcessedCommands) {
      this.processedCommands = [];
    }
    this.actionHistory = [];
    this.currentActionIndex = -1;
  }

  private emitPrepareVoteBatch(batch: PrepareVoteBatch) {
    this.ensureFullVoteFanIn(batch.messagesBySender, batch.receiverId, `vote-prepare v${batch.view}`);

    const orderedSenders = Array.from(batch.messagesBySender.keys()).sort(
      (left, right) => this.nodeIndexFromId(left) - this.nodeIndexFromId(right),
    );
    const voteMessages = orderedSenders
      .map((sender) => batch.messagesBySender.get(sender))
      .filter((candidate): candidate is SimMessage => Boolean(candidate));

    const quorumVotes = this.quorumSize();
    this.pendingVisualSteps.push({
      phaseUpdate: {
        phase: "Prepare Vote",
        detail: `${orderedSenders.length} replicas send VOTE-PREPARE to ${batch.receiverId} in view ${batch.view}.`,
        steps: [
          `Senders: ${orderedSenders.join(", ")}`,
          `Receiver: ${batch.receiverId} (leader collecting quorum)`,
          "Leader self-vote is shown as a short loop-back animation.",
          "Message: VOTE-PREPARE partial signatures",
          `Quorum target: ${quorumVotes}`,
          "Purpose: allow the leader to assemble prepareQC and advance to Pre-Commit.",
        ],
      },
      messages: voteMessages,
    });
  }

  private flushPrepareVoteBatchesForView(viewNumber: number) {
    const keysForView = Array.from(this.prepareVoteBatches.entries())
      .filter(([, batch]) => batch.view === viewNumber)
      .map(([key]) => key);

    for (const key of keysForView) {
      const batch = this.prepareVoteBatches.get(key);
      if (!batch) {
        continue;
      }

      this.emitPrepareVoteBatch(batch);
      this.prepareVoteBatches.delete(key);
      this.emittedPrepareVoteBatches.add(key);
    }
  }

  private emitPreCommitBroadcastBatch(batch: PreCommitBroadcastBatch) {
    if (!batch.messagesByReceiver.has(batch.senderId)) {
      // Backend leader path handles PRE-COMMIT locally; synthesize self-loop message for visualization.
      batch.messagesByReceiver.set(
        batch.senderId,
        new SimMessage(`pre-commit v${batch.view}`, batch.senderId, batch.senderId),
      );
    }

    const orderedReceivers = Array.from(batch.messagesByReceiver.keys()).sort(
      (left, right) => this.nodeIndexFromId(left) - this.nodeIndexFromId(right),
    );
    const fanoutMessages = orderedReceivers
      .map((receiver) => batch.messagesByReceiver.get(receiver))
      .filter((candidate): candidate is SimMessage => Boolean(candidate));

    this.pendingVisualSteps.push({
      phaseUpdate: {
        phase: "Pre-Commit",
        detail: `${batch.senderId} sends PRE-COMMIT to all replicas (including itself) in view ${batch.view}.`,
        steps: [
          `Sender: ${batch.senderId} (leader for view ${batch.view})`,
          `Receivers: ${orderedReceivers.join(", ")}`,
          "Leader self-send is shown as a short loop-back animation.",
          "Message: PRE-COMMIT carrying prepareQC",
          "Receiver action: store prepareQC and return VOTE-PRE-COMMIT.",
        ],
      },
      messages: fanoutMessages,
    });
  }

  private emitPreCommitVoteBatch(batch: PreCommitVoteBatch) {
    this.ensureFullVoteFanIn(
      batch.messagesBySender,
      batch.receiverId,
      `vote-pre-commit v${batch.view}`,
    );

    const orderedSenders = Array.from(batch.messagesBySender.keys()).sort(
      (left, right) => this.nodeIndexFromId(left) - this.nodeIndexFromId(right),
    );
    const voteMessages = orderedSenders
      .map((sender) => batch.messagesBySender.get(sender))
      .filter((candidate): candidate is SimMessage => Boolean(candidate));

    const quorumVotes = this.quorumSize();
    this.pendingVisualSteps.push({
      phaseUpdate: {
        phase: "Pre-Commit Vote",
        detail: `${orderedSenders.length} replicas send VOTE-PRE-COMMIT to ${batch.receiverId} in view ${batch.view}.`,
        steps: [
          `Senders: ${orderedSenders.join(", ")}`,
          `Receiver: ${batch.receiverId} (leader collecting quorum)`,
          "Leader self-vote is shown as a short loop-back animation.",
          "Message: VOTE-PRE-COMMIT partial signatures",
          `Quorum target: ${quorumVotes}`,
          "Purpose: allow the leader to assemble precommitQC and advance to Commit.",
        ],
      },
      messages: voteMessages,
    });
  }

  private flushPreCommitVoteBatchesForView(viewNumber: number) {
    const keysForView = Array.from(this.preCommitVoteBatches.entries())
      .filter(([, batch]) => batch.view === viewNumber)
      .map(([key]) => key);

    for (const key of keysForView) {
      const batch = this.preCommitVoteBatches.get(key);
      if (!batch) {
        continue;
      }

      this.emitPreCommitVoteBatch(batch);
      this.preCommitVoteBatches.delete(key);
      this.emittedPreCommitVoteBatches.add(key);
    }
  }

  private emitCommitBroadcastBatch(batch: CommitBroadcastBatch) {
    if (!batch.messagesByReceiver.has(batch.senderId)) {
      // Backend leader path handles COMMIT locally; synthesize self-loop message for visualization.
      batch.messagesByReceiver.set(
        batch.senderId,
        new SimMessage(`commit v${batch.view}`, batch.senderId, batch.senderId),
      );
    }

    const orderedReceivers = Array.from(batch.messagesByReceiver.keys()).sort(
      (left, right) => this.nodeIndexFromId(left) - this.nodeIndexFromId(right),
    );
    const fanoutMessages = orderedReceivers
      .map((receiver) => batch.messagesByReceiver.get(receiver))
      .filter((candidate): candidate is SimMessage => Boolean(candidate));

    this.pendingVisualSteps.push({
      phaseUpdate: {
        phase: "Commit",
        detail: `${batch.senderId} sends COMMIT to all replicas (including itself) in view ${batch.view}.`,
        steps: [
          `Sender: ${batch.senderId} (leader for view ${batch.view})`,
          `Receivers: ${orderedReceivers.join(", ")}`,
          "Leader self-send is shown as a short loop-back animation.",
          "Message: COMMIT carrying precommitQC",
          "Receiver action: update lockedQC and return VOTE-COMMIT.",
        ],
      },
      messages: fanoutMessages,
    });
  }

  private emitCommitVoteBatch(batch: CommitVoteBatch) {
    this.ensureFullVoteFanIn(batch.messagesBySender, batch.receiverId, `vote-commit v${batch.view}`);

    const orderedSenders = Array.from(batch.messagesBySender.keys()).sort(
      (left, right) => this.nodeIndexFromId(left) - this.nodeIndexFromId(right),
    );
    const voteMessages = orderedSenders
      .map((sender) => batch.messagesBySender.get(sender))
      .filter((candidate): candidate is SimMessage => Boolean(candidate));

    const quorumVotes = this.quorumSize();
    this.pendingVisualSteps.push({
      phaseUpdate: {
        phase: "Commit Vote",
        detail: `${orderedSenders.length} replicas send VOTE-COMMIT to ${batch.receiverId} in view ${batch.view}.`,
        steps: [
          `Senders: ${orderedSenders.join(", ")}`,
          `Receiver: ${batch.receiverId} (leader collecting quorum)`,
          "Leader self-vote is shown as a short loop-back animation.",
          "Message: VOTE-COMMIT partial signatures",
          `Quorum target: ${quorumVotes}`,
          "Purpose: allow the leader to assemble commitQC and advance to Decide.",
        ],
      },
      messages: voteMessages,
    });
  }

  private flushCommitVoteBatchesForView(viewNumber: number) {
    const keysForView = Array.from(this.commitVoteBatches.entries())
      .filter(([, batch]) => batch.view === viewNumber)
      .map(([key]) => key);

    for (const key of keysForView) {
      const batch = this.commitVoteBatches.get(key);
      if (!batch) {
        continue;
      }

      this.emitCommitVoteBatch(batch);
      this.commitVoteBatches.delete(key);
      this.emittedCommitVoteBatches.add(key);
    }
  }

  private emitDecideBroadcastBatch(batch: DecideBroadcastBatch) {
    const committedCommand = this.pendingDecideCommands.shift();
    if (committedCommand !== undefined) {
      this.processedCommands.push(committedCommand);
    }

    if (!batch.messagesByReceiver.has(batch.senderId)) {
      // Backend leader path handles DECIDE locally; synthesize self-loop message for visualization.
      batch.messagesByReceiver.set(
        batch.senderId,
        new SimMessage(`decide v${batch.view}`, batch.senderId, batch.senderId),
      );
    }

    const orderedReceivers = Array.from(batch.messagesByReceiver.keys()).sort(
      (left, right) => this.nodeIndexFromId(left) - this.nodeIndexFromId(right),
    );
    const fanoutMessages = orderedReceivers
      .map((receiver) => batch.messagesByReceiver.get(receiver))
      .filter((candidate): candidate is SimMessage => Boolean(candidate));

    this.pendingVisualSteps.push({
      phaseUpdate: {
        phase: "Decide",
        detail: `${batch.senderId} sends DECIDE to all replicas (including itself) in view ${batch.view}.`,
        steps: [
          `Sender: ${batch.senderId} (leader for view ${batch.view})`,
          `Receivers: ${orderedReceivers.join(", ")}`,
          "Leader self-send is shown as a short loop-back animation.",
          "Message: DECIDE carrying commitQC",
          "Receiver action: execute committed branch and advance to next view.",
        ],
        processedCommands: [...this.processedCommands],
      },
      messages: fanoutMessages,
    });
  }

  private flushDecideBroadcastBatchesForView(viewNumber: number) {
    const keysForView = Array.from(this.decideBroadcastBatches.entries())
      .filter(([, batch]) => batch.view === viewNumber)
      .map(([key]) => key);

    for (const key of keysForView) {
      const batch = this.decideBroadcastBatches.get(key);
      if (!batch) {
        continue;
      }

      this.emitDecideBroadcastBatch(batch);
      this.decideBroadcastBatches.delete(key);
      this.emittedDecideBroadcastBatches.add(key);
    }
  }

  private emitNewViewBatch(batch: NewViewBatch, batchKey: string) {
    this.ensureFullVoteFanIn(batch.messagesBySender, batch.receiverId, `new-view v${batch.view}`);

    const orderedSenders = Array.from(batch.messagesBySender.keys()).sort(
      (left, right) => this.nodeIndexFromId(left) - this.nodeIndexFromId(right),
    );
    const fanInMessages = orderedSenders
      .map((sender) => batch.messagesBySender.get(sender))
      .filter((candidate): candidate is SimMessage => Boolean(candidate));

    this.pendingVisualSteps.push({
      phaseUpdate: {
        phase: "New-View",
        detail: `All replicas send NEW-VIEW to ${batch.receiverId} for view ${batch.view}.`,
        steps: [
          `Senders: ${orderedSenders.join(", ")}`,
          `Receiver: ${batch.receiverId} (new leader for view ${batch.view})`,
          "Message: NEW-VIEW carrying highest known prepareQC.",
          "Purpose: provide evidence so the new leader can choose highQC and start Prepare.",
        ],
      },
      messages: fanInMessages,
    });

    this.newViewBatches.delete(batchKey);
    this.emittedNewViewBatches.add(batchKey);
  }

  private flushNewViewBatchesForView(viewNumber: number) {
    const entriesForView = Array.from(this.newViewBatches.entries()).filter(
      ([, batch]) => batch.view === viewNumber,
    );

    for (const [key, batch] of entriesForView) {
      this.emitNewViewBatch(batch, key);
    }
  }

  private ensureFullVoteFanIn(
    messagesBySender: Map<string, SimMessage>,
    receiverId: string,
    messageLabel: string,
  ) {
    for (let nodeIndex = 0; nodeIndex < this.numReplicas; nodeIndex++) {
      const senderId = this.toNodeId(nodeIndex);
      if (messagesBySender.has(senderId)) {
        continue;
      }

      messagesBySender.set(senderId, new SimMessage(messageLabel, senderId, receiverId));
    }
  }

  private nodeIndexFromId(nodeId: string): number {
    const parsed = Number(nodeId.replace("node-", ""));
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }

  private replicaTypeForNode(nodeIndex: number): ReplicaType {
    if (this.isFaultyNode(nodeIndex)) {
      return "adversary";
    }

    return "default";
  }

  private currentLeaderIndex(): number {
    if (this.nodes.length === 0) {
      return 0;
    }
    const normalizedView = Math.max(0, this.currentViewNumber);
    return normalizedView % this.nodes.length;
  }

  private isFaultyNode(nodeIndex: number): boolean {
    return this.faultyNodeIndices.has(nodeIndex);
  }

  private maxFaultsForReplicas(numReplicas: number): number {
    return Math.floor((numReplicas - 1) / 3);
  }

  private pickRandomFaultyIndices(numReplicas: number, numFaults: number): Set<number> {
    const allIndices = Array.from({ length: numReplicas }, (_, index) => index);

    // Fisher-Yates shuffle for unbiased random fault placement.
    for (let i = allIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = allIndices[i];
      allIndices[i] = allIndices[j] ?? allIndices[i]!;
      allIndices[j] = temp ?? allIndices[j]!;
    }

    return new Set(allIndices.slice(0, numFaults));
  }

  private shouldFaultyNodeAct(nodeIndex: number): boolean {
    // Deterministic intermittent schedule so behavior is observable and reproducible.
    return (this.faultyStepEpoch + nodeIndex) % 3 === 0;
  }

  private quorumSize(): number {
    return Math.floor((this.numReplicas * 2) / 3) + 1;
  }

  private toNodeId(nodeIndex: number): string {
    return `node-${nodeIndex}`;
  }
}
