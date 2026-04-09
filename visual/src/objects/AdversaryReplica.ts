import Konva from "konva";
import ReplicaObject, { REPLICA_SIZE } from "./ReplicaObject";
import type { SimReplica } from "../simulation/simulationManager";

export const ADVERSARY_REPLICA_COLOR = "accent";

export default class AdversaryReplica extends ReplicaObject {
  constructor(simReplica: SimReplica, onHover?: (id: string) => void) {
    super(simReplica, onHover);
    this.shape = "triangle";
    this.color = ADVERSARY_REPLICA_COLOR;
    this.spin = true;
    this.konvaNode = new Konva.RegularPolygon({
      sides: 3,
      radius: REPLICA_SIZE / 2,
      fill: "#000000",
    });

    this.initKonvaNode();
  }
}
