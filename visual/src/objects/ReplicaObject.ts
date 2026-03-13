import Konva from "konva";
import type { Point } from "./types";
import type { IFrame } from "konva/lib/types";

export const REPLICA_SIZE = 100;

export type ReplicaType = "default" | "leader" | "adversary";

export default abstract class ReplicaObject {
  position: Point;
  color: string;
  shape: "circle" | "leader" | "triangle";
  spin: boolean;
  angle: number;
  konvaNode: Konva.Shape | Konva.Group | null;
  type: ReplicaType;

  constructor(type: ReplicaType) {
    this.type = type;
    this.position = { x: 0 as number, y: 0 as number };
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

  onUpdate(frame: IFrame) {
    if (this.spin && this.konvaNode) {
      this.angle += 0.05 * frame.timeDiff;
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
