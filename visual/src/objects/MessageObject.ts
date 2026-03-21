import Konva from "konva";
import type { Point } from "./types";

export default abstract class MessageObject {
  position: Point;
  color: string;
  angle: number;
  konvaNode: Konva.Rect | null;

  constructor() {
    this.position = { x: 0.0, y: 0.0 };
    this.color = "primary";
    this.angle = 0;
    this.konvaNode = new Konva.Rect({
      width: 10,
      height: 100,
      fill: "#000000",
    });
  }

  setPosition(position: Point) {
    this.position = position;
    if (this.konvaNode) {
      this.konvaNode.position(this.position);
    }
  }

  onUpdate(deltaTime: number) {
  }

  onUpdateColor(getColor: (colorName: string) => string | undefined) {
    const newColor = getColor(this.color);
    if (this.konvaNode) {
      (this.konvaNode as Konva.Shape).fill(newColor ?? "black");
    }
  }
}