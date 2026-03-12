import { Stage, Layer, Circle, Rect, RegularPolygon, Text } from "react-konva";
import { useTheme } from "../hooks/useTheme";
import { useState } from "react";

interface Point {
  x: number;
  y: number;
}

interface ReplicaObject {
  position: Point;
  color: string;
  shape: "circle" | "leader" | "triangle";
  spin: boolean;
  angle: number;
}

interface StageObject {
  stageWidth: number;
  stageHeight: number;
  stageScale: number;
}

const REPLICA_SIZE = 100;

const DEFAULT_REPLICA_COLOR = "primary";
const LEADER_REPLICA_COLOR = "primary";
const ADVERSARY_REPLICA_COLOR = "accent";

function positionReplicasInCircle(replicas: ReplicaObject[], radius: number): ReplicaObject[] {
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;

  const angleStep = (2 * Math.PI) / replicas.length;

  return replicas.map((replica, index) => {
    const angle = index * angleStep;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);

    return {
      ...replica,
      position: { x, y },
    };
  });
}

function makeReplica(type: "default" | "leader" | "adversary"): ReplicaObject {
  const replica = {} as ReplicaObject;
  replica.position = { x: 0, y: 0 };
  replica.spin = false;
  replica.angle = 0;

  switch (type) {
    case "default":
      replica.color = DEFAULT_REPLICA_COLOR;
      replica.shape = "circle";
      break;
    case "leader":
      replica.color = LEADER_REPLICA_COLOR;
      replica.shape = "leader";
      break;
    case "adversary":
      replica.color = ADVERSARY_REPLICA_COLOR;
      replica.shape = "triangle";
      replica.spin = true;
      break;
  }

  return replica;
}

// Demo from Konva website
export default function Canvas() {
  const { getColor } = useTheme();

  const [stage, setStage] = useState<StageObject>({
    stageWidth: window.innerWidth,
    stageHeight: window.innerHeight,
    stageScale: 1.0,
  });

  let replicas: ReplicaObject[] = [
    makeReplica("default"),
    makeReplica("default"),
    makeReplica("default"),
    makeReplica("leader"),
    makeReplica("adversary"),
  ];

  replicas = positionReplicasInCircle(replicas, 300);

  const replicaComponents = replicas.map((replica, index) => {
    switch (replica.shape) {
      case "leader":
        return (
          <>
            <Rect
              key={index}
              x={replica.position.x - REPLICA_SIZE / 2}
              y={replica.position.y - REPLICA_SIZE / 2}
              width={REPLICA_SIZE}
              height={REPLICA_SIZE}
              fill={getColor(replica.color)}
            />
            <Text
              x={replica.position.x - REPLICA_SIZE / 2}
              y={replica.position.y - REPLICA_SIZE / 2}
              width={REPLICA_SIZE}
              height={REPLICA_SIZE}
              text="Leader"
              fontStyle="bold"
              align="center"
              verticalAlign="middle"
              fontSize={20}
              fontFamily="Archivo"
            ></Text>
          </>
        );
      case "triangle":
        return (
          <RegularPolygon
            key={index}
            x={replica.position.x}
            y={replica.position.y}
            sides={3}
            radius={REPLICA_SIZE / Math.sqrt(3)}
            fill={getColor(replica.color)}
            rotation={-90}
          />
        );
      case "circle":
      default:
        return (
          <Circle
            key={index}
            x={replica.position.x}
            y={replica.position.y}
            radius={REPLICA_SIZE / 2}
            fill={getColor(replica.color)}
          />
        );
    }
  });

  return (
    <Stage
      width={stage.stageWidth}
      height={stage.stageHeight}
      scaleX={stage.stageScale}
      scaleY={stage.stageScale}
      draggable
    >
      <Layer>{replicaComponents}</Layer>
    </Stage>
  );
}
