import Konva from "konva";
import ReplicaObject, { REPLICA_SIZE } from "./ReplicaObject";

const ADVERSARY_REPLICA_COLOR = "accent";

export default class AdversaryReplica extends ReplicaObject {
  constructor(type: "adversary") {
    super(type);
    this.shape = "triangle";
    this.color = ADVERSARY_REPLICA_COLOR;
    this.spin = true;
    this.konvaNode = new Konva.RegularPolygon({
      sides: 3,
      radius: REPLICA_SIZE / 2,
      fill: "#000000",
    });
  }
}
