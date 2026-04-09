
---

Short description of the overall project. This project basically is an educational visualizer for the HotStuff Byzantine fault-tolerant consensus algorithm. See below for how the protocol works.

**Overview & System Model**
- HotStuff operates in a system of n = 3f + 1 replicas, where at most f can be Byzantine (arbitrarily malicious).
- It uses the partial synchrony model: safety is always guaranteed, but liveness (progress) is only guaranteed after some unknown Global Stabilization Time (GST) when all messages arrive within a known bound Δ.
- The protocol relies on threshold signatures: each replica holds a private key, and any (n − f) = 2f + 1 partial signatures can be combined into a single compact Quorum Certificate (QC).

**Core Data Structures**
- Node: A tree node containing:
	- a client command (or batch),
	- a parent link (hash digest of parent),
	- a height, and
	- a justify field pointing to a QC
- QC (Quorum Certificate): A combined threshold signature over a tuple ⟨type, viewNumber, node⟩, representing that (n − f) replicas voted for something
- lockedQC: Each replica's lock — the highest QC for which it voted commit (initially ⊥)
- prepareQC: The highest QC for which a replica voted pre-commit (initially ⊥)
- vheight: Height of the last node a replica voted for (monotonically increasing)

**Phase-by-Phase Protocol (Basic HotStuff)**
The protocol proceeds in views, each with a unique designated leader, and each view has four sequential phases: Prepare → Pre-Commit → Commit → Decide.

---

**Step 0: View Transition (New-View)**
When a replica enters a new view (either by finishing the previous one, or by a timeout interrupt):
1. The replica sends a **NEW-VIEW message** to the leader of the next view, carrying its highest known `prepareQC`
2. If the replica timed out, it increments its viewNumber and sends this message to the new leader

**Step 1: PREPARE Phase**
**Leader side:**
- The leader waits to collect **(n − f) NEW-VIEW messages** from replicas (including itself)
	- n and f comes from the n and f of: n = 3f +1. Basically the number of nodes that are not faulty.
- From these messages, the leader selects the **highest `prepareQC`** by view number — call this `highQC`
- The leader creates a new leaf node extending `highQC.node` with the next client command using `createLeaf(highQC.node, cmd)`, call this `curProposal`
- The leader **broadcasts** a `PREPARE` message containing `(curProposal, highQC)` to all replicas
**Replica side:**
Upon receiving a PREPARE message from the leader for the current view, the replica evaluates two checks:
- The proposed node must extend `m.justify.node` (structural validity)
- The **`safeNode` predicate** must return true:
    - **Safety rule**: `m.node` extends from `lockedQC.node` (the new proposal is a descendant of what we're locked on), **OR**
    - **Liveness rule**: `m.justify.viewNumber > lockedQC.viewNumber` (the justification QC is newer than our lock, so a quorum has seen something more recent)
- If both checks pass, the replica sends a **PREPARE vote** (a partial signature over `⟨prepare, viewNumber, node⟩`) to the leader
- The replica **does not yet update any locks** at this stage

**Step 2: PRE-COMMIT Phase**
**Leader side:**
- The leader waits to collect **(n − f) PRE-COMMIT votes**
- The leader combines them into a **`precommitQC`**
- The leader **broadcasts** a `COMMIT` message carrying `precommitQC` to all replicas
**Replica side:**
- Upon receiving the COMMIT message, the replica verifies `precommitQC`
- **Critically: the replica sets `lockedQC ← precommitQC`** — this is the lock update. The replica is now committed to protecting this proposal
- The replica sends a **COMMIT vote** (partial signature over `⟨commit, viewNumber, node⟩`) to the leader

**Step 3: COMMIT Phase**
**Leader side:**
- The leader waits to collect **(n − f) PRE-COMMIT votes**
- The leader combines them into a **`precommitQC`**
- The leader **broadcasts** a `COMMIT` message carrying `precommitQC` to all replicas
**Replica side:**
- Upon receiving the COMMIT message, the replica verifies `precommitQC`
- **Critically: the replica sets `lockedQC ← precommitQC`** — this is the lock update. The replica is now committed to protecting this proposal
- The replica sends a **COMMIT vote** (partial signature over `⟨commit, viewNumber, node⟩`) to the leader

**Step 4: DECIDE Phase**
**Leader side:**
- The leader waits to collect **(n − f) COMMIT votes**
- The leader combines them into a **`commitQC`**
- The leader **broadcasts** a `DECIDE` message carrying `commitQC` to all replicas
**Replica side:**
- Upon receiving the DECIDE message with a valid `commitQC`, the replica considers the proposal **committed**
- The replica **executes all commands** in the committed branch (from the last executed node up through the committed node), in order
- The replica **responds to clients** with the execution result
- The replica increments `viewNumber` and transitions to the next view (returning to Step 0)

**Timeout / Interrupt Path**
At **any phase**, if a replica's timeout fires before a phase completes:
- The replica calls `nextView(viewNumber)`, incrementing its view counter
- The replica immediately sends a NEW-VIEW message to the **next view's leader** carrying its current `prepareQC`
- Execution jumps to the start of the new view (Step 0 above)
The timeout interval typically uses **exponential backoff**: if a view fails, the next timeout is doubled, ensuring that eventually all correct replicas will spend enough time in a view with a correct leader for progress to occur.

---

**Why Three Phases? The Key Safety Insight**

The third phase (pre-commit before commit) is what enables **linear view change** and **optimistic responsiveness**. Here is the critical reasoning:

In a **two-phase** protocol (like PBFT's core), when a replica locks after seeing a prepareQC, a new leader might not know about that lock even after collecting (n − f) new-view messages. To get replicas to unlock and accept a new proposal, the new leader must carry an expensive _proof_ (a collection of (n − f) QCs) that costs O(n²) or O(n³) authenticators.

In HotStuff's **three-phase** design, the pre-commit phase creates a critical invariant:
	**Lemma**: If any replica is locked on `precommitQC`, then at least (f + 1) _correct_ replicas have voted for the matching `prepareQC`.

This means when a new leader collects (n − f) new-view messages, at least one of them will contain this `prepareQC`. The leader simply picks the highest QC it sees — no elaborate proof required. The new leader's proposal will satisfy the **liveness rule** of `safeNode` for any replica with a stale lock, because the leader's `highQC` will have a higher view number. The total communication cost for a new leader is thus just **O(n)** — linear.

---

**Chained HotStuff: The Pipelined Variant**
The production-oriented version pipelines the three phases across consecutive views. Each view now has only a single **GENERIC** phase, and the roles rotate:

| View | Serves as...                                                        |
| ---- | ------------------------------------------------------------------- |
| v    | PREPARE for cmd proposed in v                                       |
| v+1  | PRE-COMMIT for v's cmd, PREPARE for v+1's cmd                       |
| v+2  | COMMIT for v's cmd, PRE-COMMIT for v+1's cmd, PREPARE for v+2's cmd |
| v+3  | DECIDE for v's cmd, ...                                             |

A command proposed in view v is **committed** when a node in view v+3 forms a **Three-Chain** — meaning three consecutive views each with a direct parent-child QC relationship. The replica logic checks:
- **One-Chain** (b* is direct child of b''): update `genericQC ← b*.justify`
- **Two-Chain** (b'' is also direct child of b'): update `lockedQC ← b''.justify`
- **Three-Chain** (b' is also direct child of b): **commit and execute b**
This reduces to just **two message types** (NEW-VIEW and GENERIC), and every view's communication is identical whether it's a fresh start or a view change, preserving the linear communication property.

---

The **Pacemaker** is a cleanly separated module responsible purely for liveness. It handles:'
- **`getLeader()`**: Deterministic leader election, typically round-robin. At any given view v, the leader is `(v − 1) mod n`
- **`onBeat(cmd)`**: Triggered when a new client command arrives (or on a heartbeat), prompting the current leader to call `onPropose`
- **`onNextSyncView`**: Called on timeout; increments view and sends NEW-VIEW with current `qc_high` to the new leader
- **`onReceiveNewView`**: New leader collects incoming NEW-VIEW messages to discover the highest QC before proposing
Safety (Algorithm 4) is entirely decoupled from the Pacemaker (Algorithm 5): even a misbehaving Pacemaker that proposes arbitrarily cannot violate safety, it can only affect liveness.

---

**End-to-End Summary Flow**

Client → broadcasts signed command to all replicas
- ("signed" meaning the command is secured with a "cryptographic digital signature" or uses a private key to produce a signature over the command")

Leader (view v):
  1. Collects (n−f) NEW-VIEW msgs → finds highQC
  2. Creates new leaf node extending highQC
  3. Broadcasts PREPARE(node, highQC)

Replicas:
  4. Check safeNode predicate → send PREPARE vote

Leader:
  5. Collects (n−f) PREPARE votes → forms prepareQC
  6. Broadcasts PRE-COMMIT(prepareQC)

Replicas:
  7. Verify prepareQC → send PRE-COMMIT vote

Leader:
  8. Collects (n−f) PRE-COMMIT votes → forms precommitQC
  9. Broadcasts COMMIT(precommitQC)

Replicas:
  10. Verify precommitQC → set lockedQC ← precommitQC → send COMMIT vote

Leader:
  11. Collects (n−f) COMMIT votes → forms commitQC
  12. Broadcasts DECIDE(commitQC)

Replicas:
  13. Execute committed branch → respond to client → increment view

Each full round requires **4 message steps** and **O(n) authenticators** — a small constant overhead that is entirely offset by the dramatic simplification of the view-change protocol and the ability to pipeline decisions across views.
