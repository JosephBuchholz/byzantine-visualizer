import Konva from "konva";
import { clonePoint, type Point } from "./types";

export default abstract class VisObject {
  position: Point;

  constructor(position: Point) {
    this.position = clonePoint(position);
  }

  addToLayer(layer: Konva.Layer | null) {}

  destroyKonvaNode() {}

  setPosition(position: Point) {
    this.position = clonePoint(position);
  }

  onUpdate(deltaTime: number) {}

  onUpdateColor(getColor: (colorName: string) => string | undefined) {}
}
