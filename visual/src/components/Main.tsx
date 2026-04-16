import { Group, Panel, Separator } from "react-resizable-panels";
import { Canvas, type CanvasHandle } from "./Canvas";
import LabeledSlider from "./LabeledSlider";
import LabeledInput from "./LabeledInput";
import { useEffect, useMemo, useRef, useState } from "react";
import LabeledNumericInput from "./LabeledNumericInput";
import type { StageObject } from "../objects/types";
import type ReplicaObject from "../objects/ReplicaObject";
import SimulationManager, {
  type PhaseUpdate,
  type ProtocolPathUpdate,
  SimReplica,
} from "../simulation/simulationManager.ts";
import type SimMessage from "../simulation/SimMessage";

const DEFAULT_SPEED = 25;

const MIN_REPLICAS = 1;
const MAX_REPLICAS = 100;
const DEFAULT_REPLICAS = 4;

const DEFAULT_FAULTS = 1;

const DEFAULT_PROTOCOL_PATH: ProtocolPathUpdate = {
  mode: "healthy",
  title: "Healthy Path",
  detail: "Normal Basic HotStuff round progression.",
  recentEvents: [],
};

export default function Main() {
  const canvasRef = useRef<CanvasHandle | null>(null);
  const simManager = useRef<SimulationManager>(new SimulationManager());

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
  const [isAdvancingPhase, setIsAdvancingPhase] = useState(false);
  const [clusterInitialized, setClusterInitialized] = useState(false);
  const [simulationStarted, setSimulationStarted] = useState(false);
  const [canReplay, setCanReplay] = useState(false);
  const [canReverse, setCanReverse] = useState(false);
  const [currentViewNumber, setCurrentViewNumber] = useState(0);
  const [processedCommands, setProcessedCommands] = useState<string[]>([]);
  const [debugLogLines, setDebugLogLines] = useState<string[]>([]);
  const [isDebugPopupOpen, setIsDebugPopupOpen] = useState(false);
  const [protocolPath, setProtocolPath] = useState<ProtocolPathUpdate>(DEFAULT_PROTOCOL_PATH);
  const [phaseDetail, setPhaseDetail] = useState(
    "Welcome to Basic HotStuff. Choose Number of Replicas and Number of Faults, enter a client message, then click Send Message to start. Click Next Step to animate one protocol message at a time.",
  );
  const [phaseSteps, setPhaseSteps] = useState<string[]>([
    "Choose Number of Replicas and Number of Faults.",
    "Enter a client message.",
    "Click Send Message.",
    "Click Next Step to animate one protocol message at a time.",
  ]);

  useEffect(() => {
    const manager = simManager.current;

    // Initialize simulation event callbacks once.
    manager.setOnNewReplicaCallback((replica: SimReplica) => {
      canvasRef.current?.addNewReplica(replica);
    });

    manager.setOnRemoveReplicaCallback((replicaID: string) => {
      canvasRef.current?.removeReplica(replicaID);
    });

    manager.setOnSendMessageCallback((simMessage: SimMessage) => {
      canvasRef.current?.sendMessage(simMessage);
    });

    manager.setOnPhaseChangeCallback((update: PhaseUpdate) => {
      canvasRef.current?.changePhase(update.phase);
      setPhaseDetail(update.detail);
      setPhaseSteps(update.steps);
      if (update.processedCommands) {
        setProcessedCommands(update.processedCommands);
      }
    });

    manager.setOnProtocolPathCallback((update: ProtocolPathUpdate) => {
      setProtocolPath(update);
    });

    manager.setOnViewChangeCallback((viewNumber: number) => {
      setCurrentViewNumber(viewNumber);
    });

    manager.setOnDebugLogCallback((lines: string[]) => {
      setDebugLogLines(lines);
    });

    return () => {
      manager.dispose();
    };
  }, []);

  useEffect(() => {
    canvasRef.current?.showClientFigure();
  }, []);

  useEffect(() => {
    simManager.current.setSpeed(speed);
  }, [speed]);

  // Sidebar control handlers
  const updateNumReplicas = (numReplicas: number) => {
    numReplicas = Math.max(MIN_REPLICAS, Math.min(MAX_REPLICAS, numReplicas));

    const maxFaults = Math.floor((numReplicas - 1) / 3);
    if (numberOfFaults > maxFaults) {
      setNumberOfFaults(maxFaults);
    }

    setNumberOfReplicas(numReplicas);
    setClusterInitialized(false);
    setSimulationStarted(false);
    setCanReplay(false);
    setCanReverse(false);
    setCurrentViewNumber(0);
    setProcessedCommands([]);
    setProtocolPath(DEFAULT_PROTOCOL_PATH);
    setPhaseDetail("Configuration changed. Click Run Simulation to apply settings and randomize faulty nodes.");
    setPhaseSteps([
      "Review Number of Replicas and Number of Faults.",
      "Click Run Simulation to initialize the cluster.",
      "Then use Send Message and Next Step.",
    ]);
  };

  const updateNumFaults = (numFaults: number) => {
    const maxFaults = Math.floor((numberOfReplicas - 1) / 3);
    numFaults = Math.max(0, Math.min(maxFaults, numFaults));
    setNumberOfFaults(numFaults);
    setClusterInitialized(false);
    setSimulationStarted(false);
    setCanReplay(false);
    setCanReverse(false);
    setCurrentViewNumber(0);
    setProcessedCommands([]);
    setProtocolPath(DEFAULT_PROTOCOL_PATH);
    setPhaseDetail("Configuration changed. Click Run Simulation to apply settings and randomize faulty nodes.");
    setPhaseSteps([
      "Review Number of Replicas and Number of Faults.",
      "Click Run Simulation to initialize the cluster.",
      "Then use Send Message and Next Step.",
    ]);
  };

  const handleRunSimulation = () => {
    simManager.current.beginUserAction("Run Simulation", {
      numberOfReplicas,
      numberOfFaults,
    });
    try {
      simManager.current.configureCluster(numberOfReplicas, numberOfFaults);
      canvasRef.current?.clearMessages();
      canvasRef.current?.showClientFigure();

      setClusterInitialized(true);
      setSimulationStarted(false);
      setCanReplay(false);
      setCanReverse(false);
      setCurrentViewNumber(0);
      setProcessedCommands([]);
      setProtocolPath(DEFAULT_PROTOCOL_PATH);
      setPhaseDetail(
        "Simulation initialized. Faulty nodes were randomized for this run. Enter a message and click Send Message.",
      );
      setPhaseSteps([
        "Cluster created with your chosen n and f.",
        "Faulty replicas are randomly selected for this run.",
        "Enter a client message and click Send Message.",
        "Use Next Step to advance one protocol message at a time.",
      ]);
      simManager.current.endUserAction("ok");
    } catch (error) {
      simManager.current.endUserAction("error", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const handleSendMessage = async (message: string) => {
    if (!clusterInitialized) {
      alert("Click Run Simulation first to initialize the cluster and randomize faulty nodes.");
      return;
    }

    if (message.trim() === "") {
      alert("Please enter a message before sending.");
      return;
    }

    simManager.current.beginUserAction("Send Message", {
      message,
    });
    setIsAdvancingPhase(true);
    try {
      canvasRef.current?.showClientFigure();
      const stepFound = await simManager.current.sendClientMessageAndRunFirstPhase(message);
      setSimulationStarted(simManager.current.isSimulationStarted());
      setCanReplay(simManager.current.canReplayCurrentAction());
      setCanReverse(simManager.current.canGoToPreviousAction());

      if (!stepFound) {
        const runtimeError = simManager.current.getLastRuntimeError();
        if (runtimeError) {
          alert(runtimeError);
          simManager.current.endUserAction("error", { runtimeError });
        } else {
          alert("No protocol step was found. Check replica/fault settings.");
          simManager.current.endUserAction("noop", { reason: "no-step-found" });
        }
      } else {
        simManager.current.endUserAction("ok", { stepFound: true });
      }
    } catch (error) {
      simManager.current.endUserAction("error", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      setIsAdvancingPhase(false);
    }

    setMessage("");
  };

  const handleNextStep = async () => {
    if (!simulationStarted || isAdvancingPhase) {
      return;
    }

    simManager.current.beginUserAction("Next Step");
    setIsAdvancingPhase(true);
    try {
      canvasRef.current?.clearMessages();
      canvasRef.current?.hideClientFigure();
      const stepFound = await simManager.current.nextStep();
      setSimulationStarted(simManager.current.isSimulationStarted());
      setCanReplay(simManager.current.canReplayCurrentAction());
      setCanReverse(simManager.current.canGoToPreviousAction());

      if (!stepFound) {
        const runtimeError = simManager.current.getLastRuntimeError();
        if (runtimeError) {
          alert(runtimeError);
          simManager.current.endUserAction("error", { runtimeError });
        } else {
          alert("No further protocol step found from current state.");
          simManager.current.endUserAction("noop", { reason: "no-step-found" });
        }
      } else {
        simManager.current.endUserAction("ok", { stepFound: true });
      }
    } catch (error) {
      simManager.current.endUserAction("error", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      setIsAdvancingPhase(false);
    }
  };

  const handleRepeatAction = () => {
    if (!simManager.current.canReplayCurrentAction() || isAdvancingPhase) {
      return;
    }

    simManager.current.beginUserAction("Repeat Step");
    canvasRef.current?.clearMessages();
    simManager.current.replayCurrentAction();
    setCanReplay(simManager.current.canReplayCurrentAction());
    setCanReverse(simManager.current.canGoToPreviousAction());
    simManager.current.endUserAction("ok");
  };

  const handlePreviousAction = () => {
    if (!simManager.current.canGoToPreviousAction() || isAdvancingPhase) {
      return;
    }

    simManager.current.beginUserAction("Previous Step");
    canvasRef.current?.clearMessages();
    simManager.current.goToPreviousAction();
    setCanReplay(simManager.current.canReplayCurrentAction());
    setCanReverse(simManager.current.canGoToPreviousAction());
    simManager.current.endUserAction("ok");
  };

  const handleCanvasPanelResize = (panelSize: { asPercentage: number; inPixels: number }) => {
    setStage((prevStage) => ({
      ...prevStage,
      stageWidth: window.innerWidth * (panelSize.asPercentage / 100),
    }));
  };

  const formattedDebugLogText = useMemo(() => {
    const outputLines: string[] = [];
    let lastActionKey: string | null = null;
    let emittedSystemDivider = false;

    const truncate = (value: string, max = 64) => {
      if (value.length <= max) {
        return value;
      }
      return `${value.slice(0, max - 3)}...`;
    };

    const formatTime = (iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) {
        return iso;
      }
      return date.toLocaleTimeString([], { hour12: false });
    };

    const summarizeDetails = (details?: Record<string, unknown>) => {
      if (!details || typeof details !== "object") {
        return "";
      }

      const preferredKeys = [
        "status",
        "reason",
        "nextView",
        "previousView",
        "transitionView",
        "nodeId",
        "leaderId",
        "activeView",
        "stepFound",
        "runtimeError",
        "error",
      ] as const;

      const parts: string[] = [];
      for (const key of preferredKeys) {
        if (!(key in details)) {
          continue;
        }
        const value = details[key];
        if (value === undefined || value === null) {
          continue;
        }
        parts.push(`${key}=${truncate(String(value), 28)}`);
      }

      if (parts.length > 0) {
        return parts.join(" ");
      }

      const keyCount = Object.keys(details).length;
      return keyCount > 0 ? `${keyCount} detail fields` : "";
    };

    for (const rawLine of debugLogLines) {
      try {
        const parsed = JSON.parse(rawLine) as {
          seq?: number;
          ts?: string;
          category?: string;
          view?: number;
          leader?: string;
          actionId?: number;
          action?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
        const actionId = parsed.actionId;
        const actionName = parsed.action;

        if (typeof actionId === "number" && typeof actionName === "string" && actionName.length > 0) {
          const actionKey = `${actionId}:${actionName}`;
          if (actionKey !== lastActionKey) {
            outputLines.push(
              "",
              "----------------------------------------------------------------",
              `STEP ${String(actionId).padStart(3, "0")} | ${actionName}`,
              "----------------------------------------------------------------",
            );
            lastActionKey = actionKey;
          }
        } else if (!emittedSystemDivider) {
          outputLines.push(
            "",
            "----------------------------------------------------------------",
            "SYSTEM / BACKGROUND",
            "----------------------------------------------------------------",
          );
          emittedSystemDivider = true;
          lastActionKey = null;
        }

        const detailsText = summarizeDetails(parsed.details);

        const compactLine = [
          `#${parsed.seq ?? "?"}`,
          formatTime(parsed.ts ?? ""),
          `[${parsed.category ?? "?"}]`,
          `v${parsed.view ?? "?"}`,
          truncate(parsed.message ?? "", 52),
          detailsText ? `| ${detailsText}` : "",
        ]
          .filter(Boolean)
          .join(" ");

        outputLines.push(compactLine);
        continue;
      } catch {
        // Keep non-JSON lines visible as-is.
        outputLines.push(rawLine);
      }
    }

    return outputLines.join("\n").trim();
  }, [debugLogLines]);

  const handleCopyDebugLog = async () => {
    const debugLogText = formattedDebugLogText;
    if (!debugLogText.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(debugLogText);
    } catch {
      alert("Copy failed. Your browser blocked clipboard access.");
    }
  };

  const handleClearDebugLog = () => {
    simManager.current.clearDebugLog();
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
          className="bg-secondary text-text font-primary font-semibold p-2 rounded-sm ml-2 hover:opacity-90 hover:cursor-pointer"
          onClick={handleRunSimulation}
          disabled={isAdvancingPhase}
        >
          {clusterInitialized ? "Reset Simulation" : "Run Simulation"}
        </button>
        <button
          className="bg-primary text-text-on-primary font-primary font-semibold p-2 rounded-sm ml-2 hover:bg-primary-hover hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => handleSendMessage(message)}
          disabled={!clusterInitialized || simulationStarted || isAdvancingPhase}
        >
          {isAdvancingPhase ? "Running..." : "Send Message"}
        </button>
        <button
          className="bg-secondary text-text font-primary font-semibold p-2 rounded-sm ml-2 hover:opacity-90 hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleNextStep}
          disabled={!simulationStarted || isAdvancingPhase}
        >
          Next Step
        </button>
        <button
          className="bg-primary text-text-on-primary font-primary font-semibold p-2 rounded-sm ml-2 hover:bg-primary-hover hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleRepeatAction}
          disabled={!canReplay || isAdvancingPhase}
        >
          Repeat Step
        </button>
        <button
          className="bg-primary text-text-on-primary font-primary font-semibold p-2 rounded-sm ml-2 hover:bg-primary-hover hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handlePreviousAction}
          disabled={!canReverse || isAdvancingPhase}
        >
          Previous Step
        </button>

        <h4 className="text-text mx-2 mt-4 mb-1 font-primary text-xl font-semibold">Current Step Action</h4>
        <hr className="border-accent border mx-2"></hr>
        <p className="text-text font-primary mx-2 mt-2">{phaseDetail}</p>
        <ol className="text-text font-primary mx-6 mt-2 list-decimal">
          {phaseSteps.map((step, index) => (
            <li key={`${index}-${step}`}>{step}</li>
          ))}
        </ol>

        <h4 className="text-text mx-2 mt-4 mb-1 font-primary text-xl font-semibold">Protocol Path</h4>
        <hr className="border-accent border mx-2"></hr>
        <div className="mx-2 mt-2 rounded-md border border-accent p-2">
          <div
            className={`inline-block rounded px-2 py-1 text-xs font-semibold ${
              protocolPath.mode === "healthy"
                ? "bg-green-600 text-white"
                : protocolPath.mode === "recovery"
                  ? "bg-blue-600 text-white"
                  : "bg-red-600 text-white"
            }`}
          >
            {protocolPath.title}
          </div>
          <p className="text-text font-primary mt-2 text-sm">{protocolPath.detail}</p>
          <ul className="text-text/90 font-primary mt-2 max-h-28 list-disc overflow-auto pl-5 text-xs">
            {protocolPath.recentEvents.length === 0 ? (
              <li>No notable path events yet.</li>
            ) : (
              [...protocolPath.recentEvents].reverse().map((event, index) => <li key={`${index}-${event}`}>{event}</li>)
            )}
          </ul>
        </div>

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
        <div className="relative w-full h-full">
          <Canvas ref={canvasRef} speed={speed} stage={stage} onHover={onHoverReplica}></Canvas>

          <div className="absolute top-3 right-3 z-10 flex max-w-[85%] flex-col gap-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start">
              <div className="w-44 rounded-md border border-accent bg-side-panel/90 p-3 shadow-lg backdrop-blur-sm">
                <h4 className="text-text mb-1 font-primary text-sm font-semibold">Current View</h4>
                <hr className="border-accent border mb-2"></hr>
                <div className="rounded border border-accent/50 bg-background/50 px-3 py-2 text-center">
                  <p className="text-text/80 font-primary text-xs">View Number</p>
                  <p className="text-text font-primary text-2xl font-semibold">v{currentViewNumber}</p>
                </div>
              </div>

              <div className="w-80 max-w-[45vw] rounded-md border border-accent bg-side-panel/90 p-3 shadow-lg backdrop-blur-sm">
                <h4 className="text-text mb-1 font-primary text-sm font-semibold">Processed After Decide</h4>
                <hr className="border-accent border mb-2"></hr>

                <div className="max-h-56 overflow-auto rounded-sm border border-accent/50">
                  <table className="text-text font-primary w-full text-xs">
                    <thead className="bg-background/60">
                      <tr>
                        <th className="px-2 py-1 text-left font-semibold">Height</th>
                        <th className="px-2 py-1 text-left font-semibold">Node</th>
                        <th className="px-2 py-1 text-left font-semibold">Parent</th>
                        <th className="px-2 py-1 text-left font-semibold">Command</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-accent/30">
                        <td className="px-2 py-1">0</td>
                        <td className="px-2 py-1">GENESIS</td>
                        <td className="px-2 py-1">-</td>
                        <td className="px-2 py-1">-</td>
                      </tr>

                      {processedCommands.length === 0 ? (
                        <tr className="border-t border-accent/30">
                          <td className="px-2 py-2 text-text/80" colSpan={4}>
                            Waiting for first Decide...
                          </td>
                        </tr>
                      ) : (
                        processedCommands.map((command, index) => {
                          const height = index + 1;
                          const parentHeight = height - 1;
                          return (
                            <tr className="border-t border-accent/30" key={`${height}-${command}`}>
                              <td className="px-2 py-1">{height}</td>
                              <td className="px-2 py-1">{`b${height}`}</td>
                              <td className="px-2 py-1">{parentHeight === 0 ? "GENESIS" : `b${parentHeight}`}</td>
                              <td className="px-2 py-1">{command}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          <button
            className="bg-primary text-text-on-primary font-primary fixed right-4 bottom-4 z-20 rounded-full px-3 py-2 text-xs font-semibold shadow-lg hover:bg-primary-hover hover:cursor-pointer"
            onClick={() => setIsDebugPopupOpen((open) => !open)}
          >
            {isDebugPopupOpen ? "Close Log" : "Debug Log"}
          </button>

          {isDebugPopupOpen && (
            <div className="fixed right-4 bottom-16 z-20 w-[32rem] max-w-[90vw] rounded-md border border-accent bg-side-panel/95 p-3 shadow-2xl backdrop-blur-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-text font-primary text-sm font-semibold">Dev Debug Log (JSONL)</h4>
                <div className="flex gap-2">
                  <button
                    className="bg-primary text-text-on-primary font-primary rounded px-2 py-1 text-xs font-semibold hover:bg-primary-hover hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleCopyDebugLog}
                    disabled={debugLogLines.length === 0}
                  >
                    Copy
                  </button>
                  <button
                    className="bg-secondary text-text font-primary rounded px-2 py-1 text-xs font-semibold hover:opacity-90 hover:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleClearDebugLog}
                    disabled={debugLogLines.length === 0}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <hr className="border-accent border mb-2"></hr>
              <div className="h-52 overflow-auto rounded-sm border border-accent/50 bg-background/60 p-2">
                {debugLogLines.length === 0 ? (
                  <p className="text-text/80 font-primary text-xs">
                    No debug entries yet. Run simulation steps to collect logs.
                  </p>
                ) : (
                  <pre className="text-text/90 font-mono whitespace-pre-wrap text-[11px] leading-4">
                    {formattedDebugLogText}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>
      </Panel>
    </Group>
  );
}
