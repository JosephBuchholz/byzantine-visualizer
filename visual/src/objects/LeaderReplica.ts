import Konva from "konva";
import ReplicaObject, { REPLICA_SIZE } from "./ReplicaObject";
import type { Point } from "./types";
import type { SimReplica } from "../simulation/simulationManager";

const LEADER_REPLICA_COLOR = "primary";

export default class LeaderReplica extends ReplicaObject {
  constructor(simReplica: SimReplica, onHover?: (id: string) => void) {
    super(simReplica, onHover);
    this.shape = "leader";
    this.color = LEADER_REPLICA_COLOR;

    this.konvaNode = new Konva.Group({
      width: REPLICA_SIZE,
      height: REPLICA_SIZE,
    });

    const body = new Konva.Rect({
      width: REPLICA_SIZE,
      height: REPLICA_SIZE,
      fill: "#000000",
    });
    this.konvaNode.add(body);

    this.initKonvaNode();

    /*const text = new Konva.Text({
        text: "Leader",
        fontSize: 40,
        fill: "#000000",
        width: REPLICA_SIZE,
        height: REPLICA_SIZE,
        align: "center",
        verticalAlign: "middle",
        x: 0,
        y: 0,
    });
    this.konvaNode.add(text);*/
  }

  setPosition(position: Point) {
    this.position = position;
    if (this.konvaNode) {
      this.konvaNode.position({ x: this.position.x - REPLICA_SIZE / 2, y: this.position.y - REPLICA_SIZE / 2 });
    }
  }

  // TODO: make rectangle rotate around its center:
  /*onUpdate(deltaTime: number) {
    super.onUpdate(deltaTime);

    ...TODO
    const konvaPosition = { x: this.position.x - REPLICA_SIZE / 2, y: this.position.y - REPLICA_SIZE / 2 };
    this.konvaNode?.position(konvaPosition);
  }*/

  onUpdateColor(getColor: (colorName: string) => string | undefined) {
    const newColor = getColor(this.color);
    if (this.konvaNode) {
      (this.konvaNode as Konva.Group).getChildren().forEach((child: Konva.Node) => {
        if (child instanceof Konva.Shape) {
          (child as Konva.Shape).fill(newColor ?? "black");
        }
      });
    }
  }
}
