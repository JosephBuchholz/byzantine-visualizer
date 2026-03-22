import Konva from "konva";
import { clonePoint, type Point } from "./types";

export default class MessageObject {
  position: Point;
  color: string;
  angle: number;
  konvaNode: Konva.Rect | null;
  destinationReplicaID: string;
  onDestroy: () => void;

  constructor(initialPosition: Point, destinationReplicaID: string, onDestroy: () => void) {
    this.onDestroy = onDestroy;
    this.position = clonePoint(initialPosition);
    this.destinationReplicaID = destinationReplicaID;
    this.color = "primary";
    this.angle = 0;
    this.konvaNode = new Konva.Rect({
      position: { x: this.position.x, y: this.position.y },
      width: 50,
      height: 5,
      fill: "#000000",
    });
  }

  setPosition(position: Point) {
    this.position = position;
    if (this.konvaNode) {
      this.konvaNode.position(this.position);
    }
  }

  onUpdate(deltaTime: number, getReplicaPosition: (replicaID: string) => Point | null) {
    const destPos = getReplicaPosition(this.destinationReplicaID);
    if (!destPos) {
      return;
    }
    const dx = destPos.x - this.position.x;
    const dy = destPos.y - this.position.y;
    this.angle = Math.atan2(dy, dx);

    const speed = 0.3;
    this.position.x += Math.cos(this.angle) * speed * deltaTime;
    this.position.y += Math.sin(this.angle) * speed * deltaTime;

    const DONE_THRESHOLD = 50;
    if (
      Math.abs(this.position.x - destPos.x) < DONE_THRESHOLD &&
      Math.abs(this.position.y - destPos.y) < DONE_THRESHOLD
    ) {
      this.position = destPos;
      this.onDestroy();
      return;
    }

    this.konvaNode?.position(this.position);
    this.konvaNode?.rotation((this.angle * 180) / Math.PI);
  }

  onUpdateColor(getColor: (colorName: string) => string | undefined) {
    const newColor = getColor(this.color);
    if (this.konvaNode) {
      (this.konvaNode as Konva.Shape).fill(newColor ?? "black");
    }
  }
}
