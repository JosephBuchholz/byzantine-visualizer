import { Group, Panel, Separator } from "react-resizable-panels";
import { Canvas, type CanvasHandle } from "./components/Canvas";
import Header from "./components/Header";
import ThemeProvider from "./contexts/ThemeProvider";
import LabeledSlider from "./components/LabeledSlider";
import LabeledInput from "./components/LabeledInput";
import { useEffect, useRef, useState } from "react";
import LabeledNumericInput from "./components/LabeledNumericInput";
import type { StageObject } from "./objects/types";
import type ReplicaObject from "./objects/ReplicaObject";

const DEFAULT_SPEED = 25;

const MIN_REPLICAS = 1;
const MAX_REPLICAS = 100;
const DEFAULT_REPLICAS = 10;

const DEFAULT_FAULTS = 2;

export default function App() {
  const canvasRef = useRef<CanvasHandle | null>(null);

  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [numberOfReplicas, setNumberOfReplicas] = useState(DEFAULT_REPLICAS);
  const [numberOfFaults, setNumberOfFaults] = useState(DEFAULT_FAULTS);
  const [stage, setStage] = useState<StageObject>({
    stageWidth: window.innerWidth,
    stageHeight: window.innerHeight,
    stagePosition: { x: 0, y: 0 },
    stageScale: 1.0,
  });
  const [message, setMessage] = useState("");
  const [hoveredReplica, setHoveredReplica] = useState<ReplicaObject | null>(null);

  // Initalize
  useEffect(() => {
    canvasRef.current?.updateNumReplicas(numberOfReplicas);
    canvasRef.current?.updateNumFaults(numberOfFaults);
  });

  const updateNumReplicas = (numReplicas: number) => {
    if (numReplicas < MIN_REPLICAS) {
      setNumberOfReplicas(MIN_REPLICAS);
      canvasRef.current?.updateNumReplicas(MIN_REPLICAS);
      return;
    }

    if (numReplicas > MAX_REPLICAS) {
      setNumberOfReplicas(MAX_REPLICAS);
      canvasRef.current?.updateNumReplicas(MAX_REPLICAS);
      return;
    }

    setNumberOfReplicas(numReplicas);
    canvasRef.current?.updateNumReplicas(numReplicas);
  };

  const handleSendMessage = (message: string) => {
    if (message.trim() === "") {
      alert("Please enter a message before sending.");
      return;
    }

    canvasRef.current?.sendMessage(message);
    setMessage("");
  };

  const handleCanvasPanelResize = (panelSize: { asPercentage: number; inPixels: number }) => {
    setStage((prevStage) => ({
      ...prevStage,
      stageWidth: window.innerWidth * (panelSize.asPercentage / 100),
    }));
  };

  const onHoverReplica = (replica: ReplicaObject) => {
    setHoveredReplica(replica);
  };

  return (
    <ThemeProvider>
      <Header></Header>
      <div>
        <Group>
          <Panel defaultSize="25%" minSize="20%" className="bg-side-panel">
            <h4 className="text-text mx-2 mt-2 mb-1 font-primary text-xl font-semibold">Controls</h4>
            <hr className="border-accent border mx-2"></hr>

            <LabeledSlider label="Speed" value={speed} onChange={(value) => setSpeed(value)}></LabeledSlider>
            <LabeledNumericInput
              label="Number of Replicas"
              placeholder="Enter value"
              value={numberOfReplicas}
              onChange={(value) => updateNumReplicas(value)}
            ></LabeledNumericInput>
            <LabeledNumericInput
              label="Number of Faults"
              placeholder="Enter value"
              value={numberOfFaults}
              onChange={(value) => {
                setNumberOfFaults(value);
                canvasRef.current?.updateNumFaults(value);
              }}
            ></LabeledNumericInput>
            <LabeledInput
              label="Message"
              placeholder="Enter message"
              value={message}
              onChange={(value) => setMessage(value)}
            ></LabeledInput>
            <button
              className="bg-primary text-text-on-primary font-primary font-semibold p-2 rounded-sm ml-2 hover:bg-primary-hover hover:cursor-pointer"
              onClick={() => handleSendMessage(message)}
            >
              Send Message
            </button>
            <button
              className="bg-primary text-text-on-primary font-primary font-semibold p-2 rounded-sm ml-2 hover:bg-primary-hover hover:cursor-pointer"
              onClick={() => {
                handleSendMessage("Test");
              }}
            >
              Test
            </button>

            {hoveredReplica && (
              <>
                <h4 className="text-text mx-2 mt-4 mb-1 font-primary text-xl font-semibold">Replica Information</h4>
                <hr className="border-accent border mx-2"></hr>

                <p className="text-text font-primary mx-2">ID: {hoveredReplica.id}</p>
                <p className="text-text font-primary mx-2">Type: {hoveredReplica.type}</p>
              </>
            )}
          </Panel>

          <Separator />

          <Panel minSize="25%" className="bg-background" onResize={handleCanvasPanelResize}>
            <Canvas ref={canvasRef} speed={speed} stage={stage} onHover={onHoverReplica}></Canvas>
          </Panel>
        </Group>
      </div>
    </ThemeProvider>
  );
}
