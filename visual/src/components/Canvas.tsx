import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import Konva from "konva";
import { useTheme } from "../hooks/useTheme";
import ReplicaObject from "../objects/ReplicaObject";
import makeReplica from "../objects/makeReplica";
import type { Point, StageObject } from "../objects/types";
import MessageObject from "../objects/MessageObject";
import type VisObject from "../objects/VisObject";
import TextObject from "../objects/TextObject";
import SimMessage, { CLIENT_ID } from "../simulation/SimMessage";
import type { SimReplica } from "../simulation/simulationManager.ts";

const CLIENT_SOURCE_POSITION: Point = { x: 70, y: 90 };

function positionReplicasInCircle(replicas: Map<string, ReplicaObject>, radius: number, center: Point) {
  const angleStep = (2 * Math.PI) / replicas.size;

  let index = 0;
  replicas.forEach((replica) => {
    const angle = index * angleStep;
    const x = center.x + radius * Math.cos(angle);
    const y = center.y + radius * Math.sin(angle);

    replica.setPosition({ x, y });
    index++;
  });
}

export interface CanvasHandle {
  sendMessage: (message: SimMessage) => void;
  changePhase: (phase: string) => void;
  addNewReplica: (replica: SimReplica) => void;
  removeReplica: (replicaID: string) => void;
  clearMessages: () => void;
  showClientFigure: () => void;
  hideClientFigure: () => void;
}

export const Canvas = forwardRef<
  CanvasHandle,
  { speed: number; stage: StageObject; onHover?: (replica: ReplicaObject) => void }
>(({ speed, stage, onHover }, ref) => {
  const { getColor } = useTheme();

  // Speed calculations
  const normalSpeed = 25;
  const growthFactor = 2;
  const speedPercent = Math.pow(speed, growthFactor) / Math.pow(normalSpeed, growthFactor);

  const containerRef = useRef(null);
  const stageRef = useRef<Konva.Stage | null>(null);

  const replicas: Map<string, ReplicaObject> = useMemo(() => new Map(), []);
  const messages: MessageObject[] = useMemo(() => [], []);
  const objects: VisObject[] = useMemo(() => [], []);
  const phaseText = useMemo(() => new TextObject("Phase: Initial", "text", { x: 15, y: 15 }), []);
  const clientOverlayRef = useRef<Konva.Group | null>(null);
  const clientOverlayColorRef = useRef("#111111");

  const ensureClientOverlayVisible = () => {
    const layer = stageRef.current?.getLayers()[0] ?? null;
    if (!layer) {
      return;
    }

    if (!clientOverlayRef.current) {
      const group = new Konva.Group({
        x: CLIENT_SOURCE_POSITION.x,
        y: CLIENT_SOURCE_POSITION.y,
        listening: false,
      });

      const head = new Konva.Circle({
        x: 0,
        y: -26,
        radius: 10,
        fill: clientOverlayColorRef.current,
      });
      const body = new Konva.Line({
        points: [0, -16, 0, 10],
        stroke: clientOverlayColorRef.current,
        strokeWidth: 3,
      });
      const arms = new Konva.Line({
        points: [-12, -4, 12, -4],
        stroke: clientOverlayColorRef.current,
        strokeWidth: 3,
      });
      const leftLeg = new Konva.Line({
        points: [0, 10, -12, 26],
        stroke: clientOverlayColorRef.current,
        strokeWidth: 3,
      });
      const rightLeg = new Konva.Line({
        points: [0, 10, 12, 26],
        stroke: clientOverlayColorRef.current,
        strokeWidth: 3,
      });
      const label = new Konva.Text({
        x: -24,
        y: 30,
        width: 48,
        text: "Client",
        align: "center",
        fontSize: 12,
        fill: clientOverlayColorRef.current,
      });

      group.add(head);
      group.add(body);
      group.add(arms);
      group.add(leftLeg);
      group.add(rightLeg);
      group.add(label);
      clientOverlayRef.current = group;
    }

    const overlay = clientOverlayRef.current;
    if (!overlay) {
      return;
    }

    overlay.position(CLIENT_SOURCE_POSITION);
    if (!overlay.getLayer()) {
      layer.add(overlay);
    }
    overlay.visible(true);
  };

  const hideClientOverlay = () => {
    clientOverlayRef.current?.visible(false);
  };

  const updateClientOverlayColor = useCallback(() => {
    const nextColor = getColor("text") ?? "#111111";
    clientOverlayColorRef.current = nextColor;

    const overlay = clientOverlayRef.current;
    if (!overlay) {
      return;
    }

    overlay.getChildren().forEach((child) => {
      if (child instanceof Konva.Shape || child instanceof Konva.Text) {
        child.fill(nextColor);
      }
      if (child instanceof Konva.Line) {
        child.stroke(nextColor);
      }
    });
  }, [getColor]);

  const addNewReplica = (replicas: Map<string, ReplicaObject>, newReplica: ReplicaObject) => {
    replicas.set(newReplica.id, newReplica);
    if (newReplica.konvaNode) {
      stageRef.current?.getLayers()[0].add(newReplica.konvaNode);
    }
    newReplica.onUpdateColor(getColor);
    positionReplicasInCircle(replicas, 300, { x: stage.stageWidth / 2, y: stage.stageHeight / 2 });
  };

  const addNewMessage = (messages: MessageObject[], newMessage: MessageObject) => {
    messages.push(newMessage);
    newMessage.addToLayer(stageRef.current?.getLayers()[0] ?? null);
    newMessage.onUpdateColor(getColor);
  };

  const addNewObject = (objects: VisObject[], newObject: VisObject) => {
    objects.push(newObject);
    newObject.addToLayer(stageRef.current?.getLayers()[0] ?? null);
    newObject.onUpdateColor(getColor);
  };

  const onHoverReplica = (replicaID: string) => {
    onHover?.(replicas.get(replicaID)!);
  };

  const getReplicaPositionFromID = (replicaID: string): Point => {
    if (replicaID === CLIENT_ID) {
      return CLIENT_SOURCE_POSITION;
    }

    const replica = replicas.get(replicaID);
    if (!replica) {
      console.error("Replica with ID not found:", replicaID);
      return { x: 0, y: 0 };
    }

    return replica.position;
  };

  // Events exposed to parent component
  useImperativeHandle(ref, () => ({
    sendMessage: (message: SimMessage) => {
      const isClientSource = message.fromID === CLIENT_ID;
      if (isClientSource) {
        ensureClientOverlayVisible();
      }

      const newMessage = new MessageObject(
        getReplicaPositionFromID(message.fromID),
        message.fromID,
        message.toID,
        message.content,
        () => {
          const index = messages.indexOf(newMessage);
          if (index > -1) {
            // Remove the message from the array
            messages.splice(index, 1);
          } else {
            console.warn("Message not found in array during onDestroy:", message);
          }

          newMessage.destroyKonvaNode();
        },
        getReplicaPositionFromID,
      );
      addNewMessage(messages, newMessage);
    },
    changePhase: (phase: string) => {
      phaseText.setText(`Phase: ${phase}`);
    },
    addNewReplica: (replica: SimReplica) => {
      const newReplica = makeReplica(replica, onHoverReplica);
      addNewReplica(replicas, newReplica);
    },
    removeReplica: (replicaID: string) => {
      const replica = replicas.get(replicaID);
      if (replica) {
        if (replica.konvaNode) {
          replica.konvaNode.destroy();
        }
        replicas.delete(replicaID);
      } else {
        console.warn("Attempted to remove non-existent replica with ID:", replicaID);
      }
    },
    clearMessages: () => {
      for (const message of [...messages]) {
        message.destroyKonvaNode();
      }
      messages.length = 0;
    },
    showClientFigure: () => ensureClientOverlayVisible(),
    hideClientFigure: () => hideClientOverlay(),
  }));

  useEffect(() => {
    positionReplicasInCircle(replicas, 300, { x: stage.stageWidth / 2, y: stage.stageHeight / 2 });

    // Initialization
    stageRef.current = new Konva.Stage({
      container: containerRef.current ?? undefined,
      width: stage.stageWidth,
      height: stage.stageHeight,
    });

    const layer = new Konva.Layer();
    stageRef.current.add(layer);

    addNewObject(objects, phaseText);
    ensureClientOverlayVisible();
    updateClientOverlayColor();

    replicas.forEach((replica) => {
      if (replica.konvaNode) {
        layer.add(replica.konvaNode);
      }
    });

    messages.forEach((message) => {
      message.addToLayer(layer);
    });

    objects.forEach((object) => {
      object.addToLayer(layer);
    });

    // Main animation loop
    const mainAnimation = new Konva.Animation(function (frame) {
      const deltaTime = frame.timeDiff * speedPercent;

      replicas.forEach((replica) => {
        replica.onUpdate(deltaTime);
      });

      messages.forEach((message) => {
        message.onUpdate(deltaTime);
      });

      objects.forEach((object) => {
        object.onUpdate(deltaTime);
      });
    }, layer);

    mainAnimation.start();

    return () => {
      mainAnimation.stop();
      clientOverlayRef.current?.destroy();
      clientOverlayRef.current = null;
    };
  });

  // Update colors on theme change
  useEffect(() => {
    updateClientOverlayColor();

    replicas.forEach((replica) => {
      replica.onUpdateColor(getColor);
    });

    messages.forEach((message) => {
      message.onUpdateColor(getColor);
    });

    objects.forEach((object) => {
      object.onUpdateColor(getColor);
    });
  }, [replicas, messages, objects, getColor, updateClientOverlayColor]);

  return <div ref={containerRef} />;
});
