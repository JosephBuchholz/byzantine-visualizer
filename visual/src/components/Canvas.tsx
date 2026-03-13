import { useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { useTheme } from "../hooks/useTheme";
import ReplicaObject from "../objects/ReplicaObject";
import makeReplica from "../objects/makeReplica";
import type { StageObject } from "../objects/types";

function positionReplicasInCircle(replicas: ReplicaObject[], radius: number) {
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;

  const angleStep = (2 * Math.PI) / replicas.length;

  replicas.forEach((replica, index) => {
    const angle = index * angleStep;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);

    replica.setPosition({ x, y });
  });
}

export default function Canvas() {
  const { getColor } = useTheme();

  const [stage, setStage] = useState<StageObject>({
    stageWidth: window.innerWidth,
    stageHeight: window.innerHeight,
    stageScale: 1.0,
  });

  const containerRef = useRef(null);
  const stageRef = useRef<Konva.Stage | null>(null);

  const replicas: ReplicaObject[] = useMemo(
    () => [
      makeReplica("default"),
      makeReplica("default"),
      makeReplica("default"),
      makeReplica("leader"),
      makeReplica("default"),
      makeReplica("adversary"),
    ],
    [],
  );

  positionReplicasInCircle(replicas, 300);

  useEffect(() => {
    // Initialization
    stageRef.current = new Konva.Stage({
      container: containerRef.current ?? undefined,
      width: stage.stageWidth,
      height: stage.stageHeight,
      draggable: true,
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
      replicas.forEach((replica) => {
        replica.onUpdate(frame);
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
}
