import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import Konva from "konva";
import { useTheme } from "../hooks/useTheme";
import ReplicaObject from "../objects/ReplicaObject";
import makeReplica from "../objects/makeReplica";
import type { Point, StageObject } from "../objects/types";
import MessageObject from "../objects/MessageObject";

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
  sendMessage: (message: string) => void;
  updateNumReplicas: (numReplicas: number) => void;
  updateNumFaults: (numFaults: number) => void;
}

export const Canvas = forwardRef<CanvasHandle, { speed: number; stage: StageObject }>(({ speed, stage }, ref) => {
  const { getColor } = useTheme();

  // Speed calculations
  const normalSpeed = 25;
  const growthFactor = 2;
  const speedPercent = Math.pow(speed, growthFactor) / Math.pow(normalSpeed, growthFactor);

  const containerRef = useRef(null);
  const stageRef = useRef<Konva.Stage | null>(null);

  const replicas: Map<string, ReplicaObject> = useMemo(() => new Map(), []);
  const messages: MessageObject[] = useMemo(() => [], []);

  const addNewReplica = (replicas: Map<string, ReplicaObject>, newReplica: ReplicaObject) => {
    replicas.set(newReplica.id, newReplica);
    if (newReplica.konvaNode) {
      stageRef.current?.getLayers()[0].add(newReplica.konvaNode);
    }
    positionReplicasInCircle(replicas, 300, { x: stage.stageWidth / 2, y: stage.stageHeight / 2 });
  };

  const addNewMessage = (messages: MessageObject[], newMessage: MessageObject) => {
    messages.push(newMessage);
    if (newMessage.konvaNode) {
      stageRef.current?.getLayers()[0].add(newMessage.konvaNode);
    }
    newMessage.onUpdateColor(getColor);
  };

  useImperativeHandle(ref, () => ({
    sendMessage: (message: string) => {
      const sourceIndex = Math.floor(Math.random() * replicas.size);
      const destinationIndex = Math.floor(Math.random() * replicas.size);
      const sourceReplica = Array.from(replicas.values())[sourceIndex];
      const destinationReplicaID = Array.from(replicas.keys())[destinationIndex];

      const newMessage = new MessageObject(sourceReplica.position, destinationReplicaID, () => {
        const index = messages.indexOf(newMessage);
        if (index > -1) {
          // Remove the message from the array
          messages.splice(index, 1);
        } else {
          console.warn("Message not found in array during onDestroy:", message);
        }

        if (newMessage.konvaNode) {
          newMessage.konvaNode.destroy();
        }
      });
      addNewMessage(messages, newMessage);
    },
    updateNumReplicas: (numReplicas: number) => {
      if (numReplicas > replicas.size) {
        for (let i = replicas.size; i < numReplicas; i++) {
          const makeFault = Math.random() < 0.5;

          addNewReplica(replicas, makeReplica(makeFault ? "adversary" : "default"));
        }
      } else if (numReplicas < replicas.size) {
        const replicasToRemove = Array.from(replicas.values()).slice(numReplicas);
        replicasToRemove.forEach((replica) => {
          if (replica.konvaNode) {
            replica.konvaNode.destroy();
          }
        });

        // Remove the replicas from the map
        replicasToRemove.forEach((replica) => {
          replicas.delete(replica.id);
        });
      }
    },
    updateNumFaults: (numFaults: number) => {
      console.log("Updating number of faults to:", numFaults);
    },
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

    replicas.forEach((replica) => {
      if (replica.konvaNode) {
        layer.add(replica.konvaNode);
      }
    });

    messages.forEach((message) => {
      if (message.konvaNode) {
        layer.add(message.konvaNode);
      }
    });

    // Main animation loop
    const mainAnimation = new Konva.Animation(function (frame) {
      const deltaTime = frame.timeDiff * speedPercent;

      replicas.forEach((replica) => {
        replica.onUpdate(deltaTime);
      });

      messages.forEach((message) => {
        message.onUpdate(deltaTime, (replicaID: string) => {
          const replica = replicas.get(replicaID);
          return replica ? replica.position : null;
        });
      });
    }, layer);

    mainAnimation.start();

    return () => {
      mainAnimation.stop();
    };
  });

  // Update colors on theme change
  useEffect(() => {
    replicas.forEach((replica) => {
      replica.onUpdateColor(getColor);
    });

    messages.forEach((message) => {
      message.onUpdateColor(getColor);
    });
  }, [replicas, messages, getColor]);

  return <div ref={containerRef} />;
});
