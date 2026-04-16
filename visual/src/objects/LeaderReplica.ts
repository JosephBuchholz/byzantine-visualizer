import Konva from "konva";
import ReplicaObject, { REPLICA_SIZE } from "./ReplicaObject";
import type { Point } from "./types";
import type { SimReplica } from "../simulation/simulationManager.ts";

const LEADER_REPLICA_COLOR = "secondary";

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
      stroke: "#111111",
      strokeWidth: 3,
      cornerRadius: 8,
    });
    this.konvaNode.add(body);

    const badge = new Konva.Circle({
      x: REPLICA_SIZE - 18,
      y: 18,
      radius: 14,
      fill: "#111111",
      stroke: "#ffffff",
      strokeWidth: 2,
    });
    this.konvaNode.add(badge);

    const badgeText = new Konva.Text({
      x: REPLICA_SIZE - 24,
      y: 9,
      width: 12,
      text: "L",
      fontSize: 16,
      fontStyle: "bold",
      fill: "#ffffff",
      align: "center",
      listening: false,
    });
    this.konvaNode.add(badgeText);

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

  onUpdateColor(getColor: (colorName: string) => string | undefined) {
    const newColor = getColor(this.color);
    if (this.konvaNode) {
      (this.konvaNode as Konva.Group).getChildren().forEach((child: Konva.Node) => {
        if (child instanceof Konva.Rect) {
          child.fill(newColor ?? "black");
        }
      });
    }
  }
}
