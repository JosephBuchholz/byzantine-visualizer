import Konva from "konva";
import type { Point } from "./types";

export const REPLICA_SIZE = 100;

export type ReplicaType = "default" | "leader" | "adversary";

export default abstract class ReplicaObject {
  id: string;
  position: Point;
  color: string;
  shape: "circle" | "leader" | "triangle";
  spin: boolean;
  angle: number;
  konvaNode: Konva.Shape | Konva.Group | null;
  type: ReplicaType;

  constructor(type: ReplicaType) {
    this.id = crypto.randomUUID();
    this.type = type;
    this.position = { x: 0.0, y: 0.0 };
    this.color = "primary";
    this.shape = "circle";
    this.spin = false;
    this.angle = 0;
    this.konvaNode = null;
  }

  setPosition(position: Point) {
    this.position = position;
    if (this.konvaNode) {
      this.konvaNode.position(this.position);
    }
  }

  onUpdate(deltaTime: number) {
    if (this.spin && this.konvaNode) {
      this.angle += 0.05 * deltaTime;
      this.konvaNode.rotation(this.angle);
    }
  }

  onUpdateColor(getColor: (colorName: string) => string | undefined) {
    const newColor = getColor(this.color);
    if (this.konvaNode) {
      (this.konvaNode as Konva.Shape).fill(newColor ?? "black");
    }
  }
}
