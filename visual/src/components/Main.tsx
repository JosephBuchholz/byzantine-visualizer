import { Group, Panel, Separator } from "react-resizable-panels";
import { Canvas, type CanvasHandle } from "./Canvas";
import LabeledSlider from "./LabeledSlider";
import LabeledInput from "./LabeledInput";
import { useEffect, useRef, useState } from "react";
import LabeledNumericInput from "./LabeledNumericInput";
import type { StageObject } from "../objects/types";
import type ReplicaObject from "../objects/ReplicaObject";
import SimulationManager, { SimReplica } from "../simulation/simulationManager";
import type SimMessage from "../simulation/SimMessage";

const DEFAULT_SPEED = 25;

const MIN_REPLICAS = 1;
const MAX_REPLICAS = 100;
const DEFAULT_REPLICAS = 10;

const DEFAULT_FAULTS = 2;

export default function Main() {
  const canvasRef = useRef<CanvasHandle | null>(null);
  const simManager = useRef<SimulationManager>(new SimulationManager());

  function initSimulator() {
    // Initialize simulation event callbacks
    simManager.current.setOnNewReplicaCallback((replica: SimReplica) => {
      canvasRef.current?.addNewReplica(replica);
    });

    simManager.current.setOnRemoveReplicaCallback((replicaID: string) => {
      canvasRef.current?.removeReplica(replicaID);
    });

    simManager.current.setOnSendMessageCallback((message: SimMessage) => {
      canvasRef.current?.sendMessage(message);
    });

    simManager.current.setOnPhaseChangeCallback((phase: string) => {
      canvasRef.current?.changePhase(phase);
    });
  }

  useEffect(() => {
    initSimulator();
  }, []);

  // State
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

  // Initialize with default values
  useEffect(() => {
    simManager.current.updateNumReplicas(numberOfReplicas);
  });

  // Sidebar control handlers
  const updateNumReplicas = (numReplicas: number) => {
    numReplicas = Math.max(MIN_REPLICAS, Math.min(MAX_REPLICAS, numReplicas));
    simManager.current.updateNumReplicas(numReplicas);
    setNumberOfReplicas(numReplicas);
  };

  const updateNumFaults = (numFaults: number) => {
    setNumberOfFaults(numFaults);
  };

  const handleSendMessage = (message: string) => {
    if (message.trim() === "") {
      alert("Please enter a message before sending.");
      return;
    }

    simManager.current.onSendClientMessageToRandomReplica(message);
    setMessage("");
  };

  const handleCanvasPanelResize = (panelSize: { asPercentage: number; inPixels: number }) => {
    setStage((prevStage) => ({
      ...prevStage,
      stageWidth: window.innerWidth * (panelSize.asPercentage / 100),
    }));
  };

  // Canvas event handlers
  const onHoverReplica = (replica: ReplicaObject) => {
    setHoveredReplica(replica);
  };

  return (
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
            updateNumFaults(value);
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
  );
}
