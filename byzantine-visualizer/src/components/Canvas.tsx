import { Stage, Layer, Circle } from "react-konva";
import { useTheme } from "../hooks/useTheme";

// Demo from Konva website
export default function Canvas() {
  const { getColor } = useTheme();

  return (
    <Stage width={window.innerWidth} height={window.innerHeight}>
      <Layer>
        <Circle x={200} y={100} radius={50} fill={getColor("primary")} draggable />
      </Layer>
    </Stage>
  );
}
