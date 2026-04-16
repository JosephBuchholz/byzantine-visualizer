import Konva from "konva";
import { type Point } from "./types";
import VisObject from "./VisObject";

const MESSAGE_WIDTH = 40;
const MESSAGE_HEIGHT = 10;
const SELF_LOOP_RADIUS = 76;
const SELF_LOOP_ANGULAR_SPEED = 0.006;

function elipsiseText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + "...";
}

export default class MessageObject extends VisObject {
  color: string;
  textColor: string;
  angle: number;
  konvaNode: Konva.Rect | null;
  konvaTextNode: Konva.Text | null;
  destinationReplicaID: string;
  sourceReplicaID: string;
  message: string;
  onDestroy: () => void;
  getReplicaPosition: (replicaID: string) => Point | null;
  isClientMessage: boolean;
  isSelfLoopMessage: boolean;
  loopProgress: number;

  constructor(
    initialPosition: Point,
    sourceReplicaID: string,
    destinationReplicaID: string,
    message: string,
    onDestroy: () => void,
    getReplicaPosition: (replicaID: string) => Point | null,
  ) {
    super(initialPosition);
    this.onDestroy = onDestroy;
    this.sourceReplicaID = sourceReplicaID;
    this.destinationReplicaID = destinationReplicaID;
    this.message = message;
    this.getReplicaPosition = getReplicaPosition;
    this.isClientMessage = this.message.toUpperCase().includes("CLIENT");
    this.isSelfLoopMessage = this.sourceReplicaID === this.destinationReplicaID;
    this.loopProgress = 0;
    this.color = this.isClientMessage ? "accent" : "primary";
    this.textColor = "text";
    this.angle = 0;
    this.konvaNode = new Konva.Rect({
      position: { x: this.position.x, y: this.position.y },
      width: 40,
      height: 10,
      fill: "#000000",
      stroke: this.isClientMessage ? "#111111" : undefined,
      strokeWidth: this.isClientMessage ? 2 : 0,
    });
    this.konvaNode.on("mouseover", () => {
      this.onHover();
    });
    this.konvaNode.on("mouseleave", () => {
      this.onUnhover();
    });

    this.konvaTextNode = new Konva.Text({
      position: { x: this.position.x, y: this.position.y },
      text: elipsiseText(this.message, 8),
      fontSize: this.isClientMessage ? 14 : 12,
      fill: "#000000",
      listening: false,
      visible: false,
    });

    if (this.isClientMessage) {
      this.konvaNode.scale({ x: 1.35, y: 1.35 });
    }
  }

  onHover() {
    this.konvaNode?.to({
      scaleX: 1.5,
      scaleY: 1.8,
      duration: 0.01,
    });
    this.konvaTextNode?.visible(true);
  }

  onUnhover() {
    this.konvaNode?.to({
      scaleX: 1,
      scaleY: 1,
      duration: 0.01,
    });
    this.konvaTextNode?.visible(false);
  }

  addToLayer(layer: Konva.Layer | null) {
    if (!layer) {
      return;
    }

    if (this.konvaNode) {
      layer.add(this.konvaNode);
    }
    if (this.konvaTextNode) {
      layer.add(this.konvaTextNode);
    }
  }

  destroyKonvaNode() {
    if (this.konvaNode) {
      this.konvaNode.destroy();
      this.konvaNode = null;
    }
    if (this.konvaTextNode) {
      this.konvaTextNode.destroy();
      this.konvaTextNode = null;
    }
  }

  setPosition(position: Point) {
    this.position = position;
    if (this.konvaNode) {
      // Horizontal and vertical relative to the message's angle
      const offsetHorizontal = -((MESSAGE_WIDTH * this.konvaNode.scaleX()) / 2);
      const offsetVertical = -((MESSAGE_HEIGHT * this.konvaNode.scaleY()) / 2);

      this.konvaNode.position({
        x:
          this.position.x +
          offsetHorizontal * Math.cos(this.angle) +
          offsetVertical * Math.cos(this.angle + Math.PI / 2),
        y:
          this.position.y +
          offsetHorizontal * Math.sin(this.angle) +
          offsetVertical * Math.sin(this.angle + Math.PI / 2),
      });
    }
    if (this.konvaTextNode) {
      const offsetHorizontal = -((this.konvaTextNode.width() * this.konvaTextNode.scaleX()) / 2);
      const offsetVertical = -((this.konvaTextNode.height() * this.konvaTextNode.scaleY()) / 2);

      this.konvaTextNode.position({
        x:
          this.position.x +
          offsetHorizontal * Math.cos(this.angle) +
          offsetVertical * Math.cos(this.angle + Math.PI / 2),
        y:
          this.position.y +
          offsetHorizontal * Math.sin(this.angle) +
          offsetVertical * Math.sin(this.angle + Math.PI / 2),
      });
    }
  }

  setRotation(angle: number) {
    this.angle = angle;
    if (this.konvaNode) {
      this.konvaNode.rotation((this.angle * 180) / Math.PI);
    }
    if (this.konvaTextNode) {
      this.konvaTextNode.rotation((this.angle * 180) / Math.PI);
    }
  }

  onUpdate(deltaTime: number) {
    if (this.isSelfLoopMessage) {
      const centerPos = this.getReplicaPosition(this.sourceReplicaID);
      if (!centerPos) {
        this.onDestroy();
        return;
      }

      this.loopProgress += SELF_LOOP_ANGULAR_SPEED * deltaTime;

      const theta = -Math.PI / 2 + this.loopProgress;
      const loopPosition: Point = {
        x: centerPos.x + Math.cos(theta) * SELF_LOOP_RADIUS,
        y: centerPos.y + Math.sin(theta) * SELF_LOOP_RADIUS,
      };

      this.setPosition(loopPosition);
      this.setRotation(theta + Math.PI / 2);

      if (this.loopProgress >= Math.PI * 2) {
        this.onDestroy();
      }
      return;
    }

    const destPos = this.getReplicaPosition(this.destinationReplicaID);
    if (!destPos) {
      this.onDestroy();
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

    this.setPosition(this.position);
    this.setRotation(this.angle);
  }

  onUpdateColor(getColor: (colorName: string) => string | undefined) {
    if (this.konvaNode) {
      const newColor = getColor(this.color);
      (this.konvaNode as Konva.Shape).fill(newColor ?? "black");
    }
    if (this.konvaTextNode) {
      const newTextColor = getColor(this.textColor);
      (this.konvaTextNode as Konva.Shape).fill(newTextColor ?? "black");
    }
  }
}
