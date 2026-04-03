import SimMessage, { CLIENT_ID } from "./SimMessage";

export type ReplicaType = "default" | "leader" | "adversary";

export class SimReplica {
  id: string;
  type: ReplicaType;

  constructor(id: string, type: ReplicaType) {
    this.id = id;
    this.type = type;
  }
}

export default class SimulationManager {
  private onNewReplicaCallback: ((replica: SimReplica) => void) | null;
  private onRemoveReplicaCallback: ((replicaID: string) => void) | null;
  private onSendMessageCallback: ((message: SimMessage) => void) | null;
  private onPhaseChangeCallback: ((phase: string) => void) | null;

  private replicas: Map<string, SimReplica>;

  constructor() {
    this.onNewReplicaCallback = null;
    this.onRemoveReplicaCallback = null;
    this.onSendMessageCallback = null;
    this.onPhaseChangeCallback = null;
    this.replicas = new Map();
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
  addNewReplica(type: ReplicaType) {
    const newReplica = new SimReplica(crypto.randomUUID(), type);
    this.replicas.set(newReplica.id, newReplica);
    if (this.onNewReplicaCallback) {
      this.onNewReplicaCallback(newReplica);
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

        this.addNewReplica(makeFault ? "adversary" : "default");
      }
    } else if (numReplicas < numReplicasInSim) {
      for (let i = numReplicasInSim; i > numReplicas; i--) {
        this.removeRandomReplica();
      }
    }
  }

  onSendClientMessage(message: string, toID: string) {
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

  setOnSendMessageCallback(callback: (message: SimMessage) => void) {
    this.onSendMessageCallback = callback;
  }

  setOnPhaseChangeCallback(callback: (phase: string) => void) {
    this.onPhaseChangeCallback = callback;
  }
}
