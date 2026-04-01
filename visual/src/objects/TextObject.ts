import Konva from "konva";
import VisObject from "./VisObject";
import { clonePoint, type Point } from "./types";

export default class TextObject extends VisObject {
  text: string;
  color: string;
  konvaNode: Konva.Text | null;

  constructor(text: string, color = "text", position: Point = { x: 0, y: 0 }) {
    super(position);
    this.text = text;
    this.color = color;

    this.konvaNode = new Konva.Text({
      text: this.text,
      fontSize: 20,
      fontFamily: "Archivo",
      fontStyle: "bold",
    });

    this.setPosition(this.position);
  }

  addToLayer(layer: Konva.Layer | null) {
    if (!layer) {
      return;
    }

    if (this.konvaNode) {
      layer.add(this.konvaNode);
    }
  }

  destoryKonvaNode() {
    if (this.konvaNode) {
      this.konvaNode.destroy();
      this.konvaNode = null;
    }
  }

  setPosition(position: Point) {
    this.position = clonePoint(position);
    if (this.konvaNode) {
      this.konvaNode.position({
        x: this.position.x,
        y: this.position.y,
      });
    }
  }

  onUpdateColor(getColor: (colorName: string) => string | undefined) {
    const newColor = getColor(this.color);
    if (this.konvaNode) {
      this.konvaNode.fill(newColor ?? "black");
    }
  }
}
