import { describe, expect, it } from "vitest";
import { LogLevel, MessageKind } from "../../../algorithm/src/types.ts";
import SimulationManager from "./simulationManager.ts";

type NewViewTestMessage = {
  type: MessageKind.NewView;
  viewNumber: number;
  senderId: number;
  prepareQC: {
    type: MessageKind.Prepare;
    viewNumber: number;
    nodeHash: string;
    thresholdSig: string;
  };
  partialSig: string;
};

type VisualStepSummary = {
  phaseUpdate: {
    phase: string;
  };
};

type SimulationManagerTestAccess = {
  enqueueProtocolVisualStep: (message: NewViewTestMessage, recipientNodeId: number) => void;
  pendingVisualSteps: VisualStepSummary[];
  handleBackendLog: (level: LogLevel, nodeId: number, logMessage: string) => void;
  processOneTick: () => Promise<void>;
  renderStep: (step: unknown, recordInHistory: boolean) => void;
  currentLeaderIndex: () => number;
  currentViewNumber: number;
  nodes: Array<{ id: number; step: () => Promise<void> }>;
  faultyStepEpoch: number;
  faultyNodeIndices: Set<number>;
  injectedFaultyLeaderViews: Set<number>;
};

describe("SimulationManager Protocol Path", () => {
  it("emits NEW-VIEW visualization when quorum senders are present", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    const targetView = 2;
    const nextLeaderId = 2;
    const makeNewView = (senderId: number) => ({
      type: MessageKind.NewView as const,
      viewNumber: targetView,
      senderId,
      prepareQC: {
        type: MessageKind.Prepare as const,
        viewNumber: targetView - 1,
        nodeHash: `b-${senderId}`,
        thresholdSig: `qc-${senderId}`,
      },
      partialSig: `nv-${senderId}`,
    });

    // n=4 => quorum is 3; after 3 NEW-VIEW messages, one visual step should be ready.
    testAccess.enqueueProtocolVisualStep(makeNewView(0), nextLeaderId);
    testAccess.enqueueProtocolVisualStep(makeNewView(1), nextLeaderId);
    testAccess.enqueueProtocolVisualStep(makeNewView(2), nextLeaderId);

    const pendingVisualSteps = testAccess.pendingVisualSteps;
    expect(pendingVisualSteps.length).toBe(1);
    expect(pendingVisualSteps[0]?.phaseUpdate.phase).toBe("New-View");
  });

  it("deduplicates timeout transitions for the same view", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    let latestEvents: string[] = [];
    manager.setOnProtocolPathCallback((update) => {
      latestEvents = update.recentEvents;
    });

    const log = "Transitioned to view 4 via timeout; sent NEW-VIEW to leader 0.";
    testAccess.handleBackendLog(LogLevel.Info, 0, log);
    testAccess.handleBackendLog(LogLevel.Info, 1, log);

    const matches = latestEvents.filter((event) => event === log);
    expect(matches.length).toBe(1);
  });

  it("ignores stale timeout transitions that move backward in view number", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    let latestEvents: string[] = [];
    manager.setOnProtocolPathCallback((update) => {
      latestEvents = update.recentEvents;
    });

    const newer = "Transitioned to view 5 via timeout; sent NEW-VIEW to leader 1.";
    const older = "Transitioned to view 4 via timeout; sent NEW-VIEW to leader 0.";

    testAccess.handleBackendLog(LogLevel.Info, 2, newer);
    testAccess.handleBackendLog(LogLevel.Info, 3, older);

    expect(latestEvents).toContain(newer);
    expect(latestEvents).not.toContain(older);
  });

  it("resets protocol path event history on new client request", async () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    let latestEvents: string[] = [];
    manager.setOnProtocolPathCallback((update) => {
      latestEvents = update.recentEvents;
    });

    testAccess.handleBackendLog(
      LogLevel.Info,
      0,
      "Transitioned to view 3 via timeout; sent NEW-VIEW to leader 3.",
    );
    testAccess.handleBackendLog(
      LogLevel.Info,
      1,
      "Decided block b-123; executed 1 block(s).",
    );

    await manager.sendClientMessageAndRunFirstPhase("hello");

    expect(latestEvents.length).toBe(1);
    expect(latestEvents[0]).toBe("Client request submitted: hello");
  });
});

describe("SimulationManager 4-replica 1-fault scenarios", () => {
  it("does not advance from view 1 to 2 on a single timeout signal", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    testAccess.currentViewNumber = 1;

    // For view 2, leader is node-2 in n=4.
    testAccess.handleBackendLog(
      LogLevel.Info,
      0,
      "Transitioned to view 2 via timeout; sent NEW-VIEW to leader 2.",
    );

    expect(testAccess.currentViewNumber).toBe(1);
    expect(testAccess.currentLeaderIndex()).toBe(1);
  });

  it("advances from view 1 to 2 only after quorum timeout transitions", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;

    const currentLeaders: string[] = [];
    manager.setOnNewReplicaCallback((replica) => {
      if (replica.isLeader) {
        currentLeaders.push(replica.id);
      }
    });

    manager.configureCluster(4, 1);
    testAccess.currentViewNumber = 1;

    const transitionLog = "Transitioned to view 2 via timeout; sent NEW-VIEW to leader 2.";
    testAccess.handleBackendLog(LogLevel.Info, 0, transitionLog);
    testAccess.handleBackendLog(LogLevel.Info, 3, transitionLog);
    expect(testAccess.currentViewNumber).toBe(1);

    testAccess.handleBackendLog(LogLevel.Info, 2, transitionLog);
    expect(testAccess.currentViewNumber).toBe(2);

    const leaderAfterView2 = currentLeaders[currentLeaders.length - 1];
    expect(leaderAfterView2).toBe("node-2");
  });

  it("ignores stale timeout transitions so leader does not jump backward/sideways", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;

    const currentLeaders: string[] = [];
    manager.setOnNewReplicaCallback((replica) => {
      if (replica.isLeader) {
        currentLeaders.push(replica.id);
      }
    });

    manager.configureCluster(4, 1);

    const transitionLog = "Transitioned to view 2 via timeout; sent NEW-VIEW to leader 2.";
    testAccess.currentViewNumber = 1;
    testAccess.handleBackendLog(LogLevel.Info, 0, transitionLog);
    testAccess.handleBackendLog(LogLevel.Info, 3, transitionLog);
    testAccess.handleBackendLog(LogLevel.Info, 2, transitionLog);
    const leaderAfterView2 = currentLeaders[currentLeaders.length - 1];

    // This stale line should be ignored and must not shift leader to node-1.
    testAccess.handleBackendLog(
      LogLevel.Info,
      1,
      "Transitioned to view 1 via timeout; sent NEW-VIEW to leader 1.",
    );
    const leaderAfterStale = currentLeaders[currentLeaders.length - 1];

    expect(leaderAfterView2).toBe("node-2");
    expect(leaderAfterStale).toBe("node-2");
  });

  it("emits faulty-leader withheld event once per view when node-1 is leader", async () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    // Force deterministic faulty-leader scenario: node-1 is faulty and current view is 1.
    testAccess.faultyNodeIndices = new Set([1]);
    testAccess.currentViewNumber = 1;
    testAccess.injectedFaultyLeaderViews.clear();

    let recentEvents: string[] = [];
    manager.setOnProtocolPathCallback((update) => {
      recentEvents = update.recentEvents;
    });

    await testAccess.processOneTick();
    await testAccess.processOneTick();

    const eventText = "View 1: faulty leader node-1 withheld progress.";
    const occurrences = recentEvents.filter((event) => event === eventText).length;
    expect(occurrences).toBe(1);
  });

  it("ignores stale DECIDE logs from prior round after a new client request starts", async () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    let latestEvents: string[] = [];
    manager.setOnProtocolPathCallback((update) => {
      latestEvents = update.recentEvents;
    });

    await manager.sendClientMessageAndRunFirstPhase("Message2");

    // Regression behavior we want to eliminate: stale DECIDE from previous round pollutes
    // the freshly-started request's protocol-path timeline.
    testAccess.handleBackendLog(
      LogLevel.Info,
      2,
      "Decided block b-old-round; executed 1 block(s).",
    );

    expect(latestEvents).toEqual(["Client request submitted: Message2"]);
  });

  it("does not skip directly from view 1 to view 3 in protocol-path leadership updates", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;

    const observedLeaders: string[] = [];
    manager.setOnNewReplicaCallback((replica) => {
      if (replica.isLeader) {
        observedLeaders.push(replica.id);
      }
    });

    manager.configureCluster(4, 1);

    // Force starting point to view 1 (faulty leader turn in user's scenario).
    testAccess.currentViewNumber = 1;

    // Regression behavior we want to eliminate: jumping straight to view 3 leader update.
    testAccess.handleBackendLog(
      LogLevel.Info,
      0,
      "Transitioned to view 3 via timeout; sent NEW-VIEW to leader 3.",
    );

    expect(testAccess.currentViewNumber).toBe(1);
    const latestLeader = observedLeaders[observedLeaders.length - 1];
    expect(latestLeader).not.toBe("node-3");
  });

  it("does not advance from view 2 to 3 on follower-only timeout transition", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    testAccess.currentViewNumber = 2;

    testAccess.handleBackendLog(
      LogLevel.Info,
      0,
      "Transitioned to view 3 via timeout; sent NEW-VIEW to leader 3.",
    );

    expect(testAccess.currentViewNumber).toBe(2);
    expect(testAccess.currentLeaderIndex()).toBe(2);
  });

  it("does not advance from view 2 to 3 on a single timeout signal even from target leader", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    testAccess.currentViewNumber = 2;

    // For view 3, leader is node-3 in n=4.
    testAccess.handleBackendLog(
      LogLevel.Info,
      3,
      "Transitioned to view 3 via timeout; sent NEW-VIEW to leader 3.",
    );

    expect(testAccess.currentViewNumber).toBe(2);
    expect(testAccess.currentLeaderIndex()).toBe(2);
  });

  it("advances from view 2 to 3 only after quorum timeout transitions for view 3", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    testAccess.currentViewNumber = 2;

    const transitionLog = "Transitioned to view 3 via timeout; sent NEW-VIEW to leader 3.";
    testAccess.handleBackendLog(LogLevel.Info, 0, transitionLog);
    testAccess.handleBackendLog(LogLevel.Info, 2, transitionLog);
    expect(testAccess.currentViewNumber).toBe(2);

    // n=4 quorum is 3; third distinct timeout signal should unlock the advance.
    testAccess.handleBackendLog(LogLevel.Info, 3, transitionLog);
    expect(testAccess.currentViewNumber).toBe(3);
    expect(testAccess.currentLeaderIndex()).toBe(3);
  });

  it("advances to view 3 when quorum is reached even if the last timeout signal is from a follower", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    testAccess.currentViewNumber = 2;

    const transitionLog = "Transitioned to view 3 via timeout; sent NEW-VIEW to leader 3.";
    testAccess.handleBackendLog(LogLevel.Info, 0, transitionLog);
    expect(testAccess.currentViewNumber).toBe(2);

    testAccess.handleBackendLog(LogLevel.Info, 3, transitionLog);
    expect(testAccess.currentViewNumber).toBe(2);

    // Third distinct reporter reaches quorum for n=4, so tracked view should now advance.
    testAccess.handleBackendLog(LogLevel.Info, 2, transitionLog);
    expect(testAccess.currentViewNumber).toBe(3);
    expect(testAccess.currentLeaderIndex()).toBe(3);
  });

  it("syncs tracked leader/view when rendering a live step that targets a higher view", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    testAccess.currentViewNumber = 2;

    testAccess.renderStep(
      {
        phaseUpdate: {
          phase: "New-View",
          detail: "node-2 sends NEW-VIEW to node-3 targeting view 3.",
          steps: [],
        },
        messages: [
          {
            content: "new-view v3",
            fromID: "node-2",
            toID: "node-3",
          },
        ],
      },
      true,
    );

    expect(testAccess.currentViewNumber).toBe(3);
    expect(testAccess.currentLeaderIndex()).toBe(3);
  });

  it("rotates tick stepping start index so node-2 leader is not starved by low-index activity", async () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;

    manager.configureCluster(4, 1);
    testAccess.currentViewNumber = 2;
    testAccess.faultyNodeIndices = new Set([1]);
    testAccess.injectedFaultyLeaderViews.clear();
    testAccess.faultyStepEpoch = 0;

    const counts = [0, 0, 0, 0];
    const makeNode = (id: number) => ({
      id,
      step: async () => {
        counts[id] += 1;
        // First node stepped each tick emits one visual step, triggering early return.
        testAccess.pendingVisualSteps.push({
          phaseUpdate: { phase: `tick-${id}` },
        });
      },
    });

    testAccess.nodes = [makeNode(0), makeNode(1), makeNode(2), makeNode(3)];
    testAccess.pendingVisualSteps = [];

    await testAccess.processOneTick();
    testAccess.pendingVisualSteps = [];
    await testAccess.processOneTick();
    testAccess.pendingVisualSteps = [];
    await testAccess.processOneTick();

    // Without rotation this stays at 0, and node-2 can be effectively skipped.
    expect(counts[2]).toBeGreaterThan(0);
  });

  it("does not count illegal forward timeout jumps toward later quorum evidence", () => {
    const manager = new SimulationManager();
    const testAccess = manager as unknown as SimulationManagerTestAccess;
    manager.configureCluster(4, 1);

    testAccess.currentViewNumber = 2;

    // Illegal jump from v2 directly to v4 must be ignored and must not pre-seed reporters for v4.
    testAccess.handleBackendLog(
      LogLevel.Info,
      0,
      "Transitioned to view 4 via timeout; sent NEW-VIEW to leader 0.",
    );
    expect(testAccess.currentViewNumber).toBe(2);

    // Advance to v3 with valid quorum timeout evidence.
    const toView3 = "Transitioned to view 3 via timeout; sent NEW-VIEW to leader 3.";
    testAccess.handleBackendLog(LogLevel.Info, 0, toView3);
    testAccess.handleBackendLog(LogLevel.Info, 2, toView3);
    testAccess.handleBackendLog(LogLevel.Info, 3, toView3);
    expect(testAccess.currentViewNumber).toBe(3);

    // Only two fresh reporters for v4 should not advance if illegal pre-seed was discarded.
    const toView4 = "Transitioned to view 4 via timeout; sent NEW-VIEW to leader 0.";
    testAccess.handleBackendLog(LogLevel.Info, 1, toView4);
    testAccess.handleBackendLog(LogLevel.Info, 2, toView4);
    expect(testAccess.currentViewNumber).toBe(3);

    // Third fresh reporter should now unlock the advance.
    testAccess.handleBackendLog(LogLevel.Info, 3, toView4);
    expect(testAccess.currentViewNumber).toBe(4);
    expect(testAccess.currentLeaderIndex()).toBe(0);
  });
});
