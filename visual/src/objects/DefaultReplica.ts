import Konva from "konva";
import ReplicaObject, { REPLICA_SIZE } from "./ReplicaObject";
import type { SimReplica } from "../simulation/simulationManager.ts";

const DEFAULT_REPLICA_COLOR = "primary";

export default class DefaultReplica extends ReplicaObject {
  constructor(simReplica: SimReplica, onHover?: (id: string) => void) {
    super(simReplica, onHover);
    this.shape = "circle";
    this.color = DEFAULT_REPLICA_COLOR;
    this.konvaNode = new Konva.Circle({
      radius: REPLICA_SIZE / 2,
      fill: "#000000",
    });

    this.attachLeaderMarker();

    this.initKonvaNode();
  }
}
