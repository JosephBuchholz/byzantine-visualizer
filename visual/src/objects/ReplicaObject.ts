import Konva from "konva";
import type { Point } from "./types";
import type { SimReplica } from "../simulation/simulationManager.ts";

export const REPLICA_SIZE = 100;

export type ReplicaType = "default" | "adversary";

export default abstract class ReplicaObject {
  id: string;
  position: Point;
  color: string;
  shape: "circle" | "leader" | "triangle";
  spin: boolean;
  angle: number;
  konvaNode: Konva.Shape | Konva.Group | null;
  type: ReplicaType;
  isLeader: boolean;
  leaderLabelNode: Konva.Text | null;
  onHoverCallback?: (id: string) => void;
  onUnhoverCallback?: (id: string) => void;

  constructor(simReplica: SimReplica, onHover?: (id: string) => void) {
    this.id = simReplica.id;
    this.type = simReplica.type;
    this.position = { x: 0.0, y: 0.0 };
    this.color = "primary";
    this.shape = "circle";
    this.spin = false;
    this.angle = 0;
    this.konvaNode = null;
    this.isLeader = simReplica.isLeader;
    this.leaderLabelNode = null;
    this.onHoverCallback = onHover;
  }

  protected attachLeaderMarker() {
    if (!this.konvaNode || !this.isLeader) {
      return;
    }

    if (!(this.konvaNode instanceof Konva.Group)) {
      const baseNode = this.konvaNode;
      const wrapper = new Konva.Group({
        width: REPLICA_SIZE,
        height: REPLICA_SIZE,
      });

      baseNode.position({ x: REPLICA_SIZE / 2, y: REPLICA_SIZE / 2 });
      wrapper.add(baseNode);
      this.konvaNode = wrapper;
    }

    this.leaderLabelNode = new Konva.Text({
      x: 0,
      y: REPLICA_SIZE / 2 - 12,
      width: REPLICA_SIZE,
      text: "L",
      align: "center",
      fontStyle: "bold",
      fontSize: 26,
      fill: "#ffffff",
      listening: false,
    });

    (this.konvaNode as Konva.Group).add(this.leaderLabelNode);
  }

  setOnHover(onHover: (id: string) => void) {
    this.onHoverCallback = onHover;
  }

  setOnUnhovered(onUnhovered: (id: string) => void) {
    this.onUnhoverCallback = onUnhovered;
  }

  onHover() {
    this.konvaNode?.to({
      scaleX: 1.1,
      scaleY: 1.1,
      duration: 0.01,
    });
  }

  onUnhover() {
    this.konvaNode?.to({
      scaleX: 1,
      scaleY: 1,
      duration: 0.01,
    });
  }

  initKonvaNode() {
    if (this.konvaNode) {
      const node = this.konvaNode as Konva.Node;

      node.on("mouseover", () => {
        this.onHover();
        if (this.onHoverCallback) {
          this.onHoverCallback(this.id);
        }
      });

      node.on("mouseleave", () => {
        this.onUnhover();
        if (this.onUnhoverCallback) {
          this.onUnhoverCallback(this.id);
        }
      });
    }
  }

  setPosition(position: Point) {
    this.position = position;
    if (this.konvaNode) {
      if (this.konvaNode instanceof Konva.Group) {
        this.konvaNode.position({
          x: this.position.x - REPLICA_SIZE / 2,
          y: this.position.y - REPLICA_SIZE / 2,
        });
      } else {
        this.konvaNode.position(this.position);
      }
    }
  }

  onUpdate(deltaTime: number) {
    if (this.spin && this.konvaNode) {
      this.angle += 0.05 * deltaTime;

      // For leader-marked spinners (triangle + centered L), rotate only the base shape
      // so the L text stays fixed and readable.
      if (this.konvaNode instanceof Konva.Group && this.leaderLabelNode) {
        const rotatingChild = this.konvaNode
          .getChildren()
          .find((child) => child instanceof Konva.Shape && !(child instanceof Konva.Text));

        if (rotatingChild) {
          rotatingChild.rotation(this.angle);
          return;
        }
      }

      this.konvaNode.rotation(this.angle);
    }
  }

  onUpdateColor(getColor: (colorName: string) => string | undefined) {
    const newColor = getColor(this.color);
    if (this.konvaNode) {
      if (this.konvaNode instanceof Konva.Group) {
        this.konvaNode.getChildren().forEach((child) => {
          if (child instanceof Konva.Shape && !(child instanceof Konva.Text)) {
            child.fill(newColor ?? "black");
          }
        });
      } else {
        (this.konvaNode as Konva.Shape).fill(newColor ?? "black");
      }
    }

    if (this.leaderLabelNode) {
      this.leaderLabelNode.fill(getColor("text-on-primary") ?? "#ffffff");
    }
  }
}
