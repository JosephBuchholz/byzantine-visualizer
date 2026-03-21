import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import Konva from "konva";
import { useTheme } from "../hooks/useTheme";
import ReplicaObject from "../objects/ReplicaObject";
import makeReplica from "../objects/makeReplica";
import type { Point, StageObject } from "../objects/types";
import type MessageObject from "../objects/MessageObject";

function positionReplicasInCircle(replicas: ReplicaObject[], radius: number, center: Point) {
  const angleStep = (2 * Math.PI) / replicas.length;

  replicas.forEach((replica, index) => {
    const angle = index * angleStep;
    const x = center.x + radius * Math.cos(angle);
    const y = center.y + radius * Math.sin(angle);

    replica.setPosition({ x, y });
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

  const replicas: ReplicaObject[] = useMemo(() => [], []);

  const addNewReplica = (replicas: ReplicaObject[], newReplica: ReplicaObject) => {
    replicas.push(newReplica);
    if (newReplica.konvaNode) {
      stageRef.current?.getLayers()[0].add(newReplica.konvaNode);
    }
    positionReplicasInCircle(replicas, 300, { x: stage.stageWidth / 2, y: stage.stageHeight / 2 });
  };

  useImperativeHandle(ref, () => ({
    sendMessage: (message: string) => {
      console.log("Message received in Canvas:", message);
    },
    updateNumReplicas: (numReplicas: number) => {
      if (numReplicas > replicas.length) {
        for (let i = replicas.length; i < numReplicas; i++) {
          const makeFault = Math.random() < 0.5;

          addNewReplica(replicas, makeReplica(makeFault ? "adversary" : "default"));
        }
      } else if (numReplicas < replicas.length) {
        const replicasToRemove = replicas.splice(numReplicas);
        replicasToRemove.forEach((replica) => {
          if (replica.konvaNode) {
            replica.konvaNode.destroy();
          }
        });
      }
    },
    updateNumFaults: (numFaults: number) => {
      console.log("Updating number of faults to:", numFaults);
    },
  }));

  positionReplicasInCircle(replicas, 300, { x: stage.stageWidth / 2, y: stage.stageHeight / 2 });
  useEffect(() => {
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

    // Main animation loop
    const mainAnimation = new Konva.Animation(function (frame) {
      const deltaTime = frame.timeDiff * speedPercent;

      replicas.forEach((replica) => {
        replica.onUpdate(deltaTime);
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
  }, [replicas, getColor]);

  return <div ref={containerRef} />;
});
