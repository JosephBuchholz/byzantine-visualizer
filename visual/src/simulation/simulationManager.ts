import SimMessage, { CLIENT_ID } from "./SimMessage";
import BasicHotStuffNode from "../../../algorithm/src/hotstuff/basic.ts";
import type { HotStuffConfig } from "../../../algorithm/src/index.ts";
import { InMemoryDataStore } from "../../../algorithm/src/data/store.ts";
import { HotStuffAction } from "../../../algorithm/src/types.ts";

export class SimReplica {
  id: string;
  isAdversary: boolean;
  isLeader: boolean;

  constructor(id: string, isAdversary: boolean, isLeader: boolean) {
    this.id = id;
    this.isAdversary = isAdversary;
    this.isLeader = isLeader;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class SimulationManager {
  private onNewReplicaCallback: ((replica: SimReplica) => void) | null;
  private onRemoveReplicaCallback: ((replicaID: string) => void) | null;
  private onUpdateReplicaCallback: ((replica: SimReplica) => void) | null;
  private onSendMessageCallback: ((message: SimMessage) => void) | null;
  private onPhaseChangeCallback: ((phase: string) => void) | null;

  private replicas: Map<string, SimReplica>;

  private hotStuffConfig: Required<HotStuffConfig> = {
    numNodes: 10,
    loopTimeoutMaxMs: 100,
    leaderTimeoutMaxMs: 100,
    maxBatchSize: 10,
    maxBatchWaitTimeMs: 100,
    logger: this.hotStuffLogger.bind(this),
  };

  private nodes = new Map<string, BasicHotStuffNode>();

  private messageIndex = 0;

  constructor() {
    this.onNewReplicaCallback = null;
    this.onRemoveReplicaCallback = null;
    this.onUpdateReplicaCallback = null;
    this.onSendMessageCallback = null;
    this.onPhaseChangeCallback = null;
    this.replicas = new Map();
    this.nodes = new Map();
  }

  async hotStuffLogger(level: string, id: number, message: string, action: HotStuffAction, data?: unknown) {
    switch (action) {
      case HotStuffAction.StartingAsLeader: {
        this.onPhaseChangeCallback?.("Leader Elected");
        const nodeID = this.getNodeIDByIndex(id);
        if (!nodeID) {
          console.warn(`Could not find node ID for index ${id}. Replica not updated in simulation.`);
          return;
        }

        const replica = this.replicas.get(nodeID);
        if (!replica) {
          console.warn(`Could not find replica for node ID ${nodeID}. Replica not updated in simulation.`);
          return;
        }
        replica.isLeader = true;

        this.onUpdateReplicaCallback?.(replica);
        break;
      }
      case HotStuffAction.SendMessage: {
        const dataObj = data as { message: unknown; toId: number } | undefined;
        if (!dataObj) {
          console.warn("Failed to send message in simulation: data is undefined.");
          return;
        }

        const fromId = this.getNodeIDByIndex(id);
        const toId = this.getNodeIDByIndex(dataObj.toId);
        if (!fromId || !toId) {
          console.warn(`Failed to send message in simulation: fromId ${fromId}, toId ${toId}`);
          return;
        }

        this.onSendMessage(new SimMessage(message, fromId, toId));

        console.log("delaying");
        await delay(3000);
        console.log("done delaying");

        break;
      }
    }
  }

  // Simulation events
  onSendMessage(message: SimMessage) {
    if (this.onSendMessageCallback) {
      this.onSendMessageCallback(message);
    }
  }

  // Simulation accessors
  getNumReplicas(): number {
    return this.replicas.size;
  }

  getRandomReplica(): SimReplica | null {
    if (this.replicas.size === 0) {
      return null;
    }
    const randomIndex = Math.floor(Math.random() * this.replicas.size);
    return Array.from(this.replicas.values())[randomIndex];
  }

  // Simulation control methods
  startSimulation() {
    this.nodes.forEach((node) => {
      node.run(this.getNodeArray());
    });
  }

  addNewReplica(isAdversary: boolean, isLeader: boolean) {
    const newID = `replica-${crypto.randomUUID()}`;

    // Add HotStuff node
    // TODO: change id to string and use newID
    const newNode = new BasicHotStuffNode(this.nodes.size, this.hotStuffConfig, new InMemoryDataStore());
    this.nodes.set(newID, newNode);

    // Add sim replica
    const newSimReplica = new SimReplica(newID, isAdversary, isLeader);
    this.replicas.set(newSimReplica.id, newSimReplica);
    if (this.onNewReplicaCallback) {
      this.onNewReplicaCallback(newSimReplica);
    }
  }

  removeRandomReplica() {
    if (this.replicas.size > 0) {
      const randomReplica = this.getRandomReplica();
      if (!randomReplica) {
        console.warn("No replicas available to remove.");
        return;
      }

      this.replicas.delete(randomReplica.id);
      if (this.onRemoveReplicaCallback) {
        this.onRemoveReplicaCallback(randomReplica.id);
      }
    }
  }

  updateNumReplicas(numReplicas: number) {
    const numReplicasInSim = this.getNumReplicas();

    if (numReplicas > numReplicasInSim) {
      for (let i = numReplicasInSim; i < numReplicas; i++) {
        const makeFault = Math.random() < 0.5;

        this.addNewReplica(makeFault ? true : false, false);
      }
    } else if (numReplicas < numReplicasInSim) {
      for (let i = numReplicasInSim; i > numReplicas; i--) {
        this.removeRandomReplica();
      }
    }
  }

  onSendClientMessage(message: string, toID: string) {
    this.nodes.get(toID)?.put(this.messageIndex.toString(), message);
    this.messageIndex++;

    if (this.onSendMessageCallback) {
      this.onSendMessageCallback(new SimMessage(message, CLIENT_ID, toID));
    }
  }

  onSendClientMessageToRandomReplica(message: string) {
    const randomReplica = this.getRandomReplica();
    if (!randomReplica) {
      console.warn("No replicas available to send message to.");
      return;
    }

    this.onSendClientMessage(message, randomReplica.id);
  }

  // Callbacks
  setOnNewReplicaCallback(callback: (replica: SimReplica) => void) {
    this.onNewReplicaCallback = callback;
  }

  setOnRemoveReplicaCallback(callback: (replicaID: string) => void) {
    this.onRemoveReplicaCallback = callback;
  }

  setOnUpdateReplicaCallback(callback: (replica: SimReplica) => void) {
    this.onUpdateReplicaCallback = callback;
  }

  setOnSendMessageCallback(callback: (message: SimMessage) => void) {
    this.onSendMessageCallback = callback;
  }

  setOnPhaseChangeCallback(callback: (phase: string) => void) {
    this.onPhaseChangeCallback = callback;
  }

  // Other
  getNodeArray(): BasicHotStuffNode[] {
    return Array.from(this.nodes.values()).sort((a, b) => a.id - b.id);
  }

  getRandomNode(): BasicHotStuffNode | null {
    const nodesArray = this.getNodeArray();
    if (nodesArray.length === 0) {
      return null;
    }
    const randomIndex = Math.floor(Math.random() * nodesArray.length);
    return nodesArray[randomIndex];
  }

  getNodeIDByIndex(index: number): string | null {
    for (const [nodeID, node] of this.nodes.entries()) {
      if (node.id === index) {
        return nodeID;
      }
    }

    return null;
  }
}
