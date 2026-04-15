# Basic HotStuff Protocol Paths — Implementation Reference

> **Scope:** This document covers **Basic HotStuff only** — the non-chained, non-pipelined variant
> described in Algorithm 2 of *HotStuff: BFT Consensus with Linearity and Responsiveness*
> (Yin et al., PODC 2019) and the extended version *HotStuff: BFT Consensus in the Lens of
> Blockchain* (arXiv:1803.05069v6). Chained HotStuff (Algorithm 3), Event-Driven HotStuff
> (Algorithm 4), and the Pacemaker (Algorithm 5) are out of scope here.
>
> **Purpose:** This file is intended to give an AI model enough detail to implement all
> protocol paths in code, including success paths, failure paths, recovery paths, and
> complete system-failure paths caused by exceeding the fault threshold.

---

## Table of Contents

1. [System model and preconditions](#1-system-model-and-preconditions)
2. [Core data structures](#2-core-data-structures)
3. [Path 1 — Happy path (stable leader, no faults)](#3-path-1--happy-path-stable-leader-no-faults)
4. [Path 2 — Timeout and view change](#4-path-2--timeout-and-view-change)
5. [Path 3 — Faulty or Byzantine leader](#5-path-3--faulty-or-byzantine-leader)
6. [Path 4 — Replica locked on stale branch (liveness recovery)](#6-path-4--replica-locked-on-stale-branch-liveness-recovery)
7. [Path 5 — Pre-GST network partition](#7-path-5--pre-gst-network-partition)
8. [Path 7 — Quorum stall (fault threshold exceeded, liveness lost)](#8-path-7--quorum-stall-fault-threshold-exceeded-liveness-lost)
9. [Path 8 — Forged QC (fault threshold exceeded, safety violated)](#9-path-8--forged-qc-fault-threshold-exceeded-safety-violated)
10. [Path 9 — Quorum intersection breakdown (fault threshold exceeded)](#10-path-9--quorum-intersection-breakdown-fault-threshold-exceeded)
11. [Invariants every implementation must preserve](#11-invariants-every-implementation-must-preserve)
12. [Path interaction summary table](#12-path-interaction-summary-table)

---

## 1. System Model and Preconditions

### Replica set

- There are exactly `n = 3f + 1` replicas, indexed `i ∈ {1, …, n}`.
- At most `f` replicas are Byzantine-faulty. The remaining `n - f` are correct.
- Byzantine replicas are assumed to be coordinated by a single adversary that knows all
  internal state of faulty replicas, including their private keys.
- Correct replicas follow the protocol exactly as specified.

### Network model

- Communication is **point-to-point, authenticated, and reliable** between correct replicas.
  If a correct replica sends a message to another correct replica, it is eventually received.
- A "broadcast" means the sender sends the same point-to-point message to every replica,
  including itself.
- The **partial synchrony model** (Dwork, Lynch, Stockmeyer 1988) is assumed:
  - There exists a known message delay bound `Δ`.
  - There exists an unknown **Global Stabilization Time (GST)**.
  - After GST, all messages between correct replicas arrive within `Δ`.
  - Before GST, messages may be arbitrarily delayed or reordered. Safety must hold always;
    liveness is only guaranteed after GST.

### Cryptographic primitives

#### Threshold signatures

- A `(k, n)`-threshold signature scheme is used with `k = 2f + 1`.
- Each replica `i` holds a distinct private key and can produce a **partial signature**:
  `ρ_i ← tsign_i(m)` over a message `m`.
- Any set of `k = 2f + 1` partial signatures for the same message can be combined into
  a single compact **threshold signature**:
  `σ ← tcombine(m, {ρ_i | i ∈ I})` where `|I| = k`.
- Any party can verify: `tverify(m, σ) → true/false`.
- Security property: an adversary controlling fewer than `k - f = f + 1` signing oracles
  cannot produce a valid signature. This is what makes forging a QC impossible when `f`
  is within bounds.

#### Hash function

- A collision-resistant hash function `h` is used to identify nodes.
- `h(node)` serves as the node's unique identifier and as the parent pointer in child nodes.

### Complexity metric

- The paper measures **authenticator complexity**: the total number of partial signatures
  or threshold signatures received across all replicas to reach one consensus decision.
- In each phase, the leader sends one message containing one threshold signature (the QC),
  and each replica responds with one partial signature. Total per phase: `O(n)`.
- With a constant number of phases, total per view: `O(n)`.

---

## 2. Core Data Structures

### Node (tree node)

```
Node {
  cmd        : client command (or batch of commands)
  parent     : h(parent_node)   -- hash digest of parent node
  -- populated by protocol:
  viewNumber : integer           -- view in which this node was proposed
}
```

Each node's identity is `h(node)`. Nodes form a tree rooted at a genesis node `b_0`.
A **branch** led by node `b` is the path from `b` back to `b_0` via parent links.
Two branches are **conflicting** if neither is a prefix of the other.
Two nodes are conflicting if the branches they lead are conflicting.

### Quorum Certificate (QC)

```
QC {
  type       : message type ∈ {prepare, pre-commit, commit}
  viewNumber : integer
  node       : Node
  sig        : threshold signature over ⟨type, viewNumber, h(node)⟩
}
```

A QC is **valid** if `tverify(⟨qc.type, qc.viewNumber, h(qc.node)⟩, qc.sig) = true`.

### Message

```
Message {
  type       : ∈ {new-view, prepare, pre-commit, commit, decide}
  viewNumber : integer          -- sender's current view
  node       : Node | ⊥
  justify    : QC | ⊥
  partialSig : tsign_r(⟨type, viewNumber, h(node)⟩) | ⊥
               -- present only in vote messages sent by replicas
}
```

### Per-replica state variables

```
viewNumber  : integer, initially 1
lockedQC    : QC | ⊥, initially ⊥
             -- highest QC for which this replica voted commit
prepareQC   : QC | ⊥, initially ⊥
             -- highest QC for which this replica voted pre-commit
```

---

## 3. Path 1 — Happy Path (Stable Leader, No Faults)

**Preconditions:**
- Network is synchronous (post-GST).
- The leader for `curView` is correct.
- All `n - f` or more correct replicas are live and synchronized on the same view.
- No replica is locked on a conflicting branch (or the `safeNode` liveness rule handles it).

**This path produces a committed decision in exactly four sequential phases.**

---

### Phase 1: Prepare

**Leader actions:**

1. Wait for `(n - f)` `new-view` messages tagged for `curView - 1`:
   `M = { m | m.type = new-view ∧ m.viewNumber = curView - 1 }`
2. From `M`, select the `prepareQC` with the highest `viewNumber`:
   `highQC = argmax_{m ∈ M} { m.justify.viewNumber }.justify`
   If all `justify` fields are `⊥` (first view), treat `highQC.viewNumber = 0`.
3. Create a new leaf node extending `highQC.node`:
   ```
   curProposal = createLeaf(highQC.node, client_command)
   -- sets curProposal.parent = h(highQC.node)
   -- sets curProposal.cmd = client_command
   ```
4. Broadcast `Msg(prepare, curProposal, highQC)` to all replicas.

**Replica actions (upon receiving prepare message `m` from `leader(curView)`):**

1. Verify `m.type = prepare` and `m.viewNumber = curView`.
2. Verify `m.node` extends from `m.justify.node`:
   `m.node.parent = h(m.justify.node)`
3. Evaluate `safeNode(m.node, m.justify)`:
   ```
   safeNode(node, qc):
     return (node extends from lockedQC.node)   -- safety rule
         OR (qc.viewNumber > lockedQC.viewNumber) -- liveness rule
   ```
   `lockedQC` is `⊥` initially, so the safety rule trivially passes on first view.
4. If both checks pass: send `voteMsg(prepare, m.node, ⊥)` to `leader(curView)`.
   The vote contains `partialSig = tsign_r(⟨prepare, curView, h(m.node)⟩)`.

**Correctness note:** `highQC` is the highest among `(n - f)` replicas. Because any prior
commit decision requires a quorum of `(n - f)` commit votes, and any two quorums of size
`(n - f)` overlap by at least `f + 1` correct replicas, no higher view could have reached
a commit decision on a conflicting branch without at least one correct replica in this
quorum knowing about it. Therefore `highQC.node` is safe to extend.

---

### Phase 2: Pre-Commit

**Leader actions:**

1. Wait for `(n - f)` prepare votes for `curView`:
   `V = { v | v.type = prepare ∧ v.viewNumber = curView }`
2. Combine votes into `prepareQC`:
   `prepareQC = QC(V)`
   where `QC(V).sig = tcombine(⟨prepare, curView, h(curProposal)⟩, {v.partialSig | v ∈ V})`
3. Broadcast `Msg(pre-commit, ⊥, prepareQC)` to all replicas.

**Replica actions (upon receiving pre-commit message `m` from `leader(curView)`):**

1. Verify `m.type = pre-commit` and `m.justify.type = prepare` and
   `m.justify.viewNumber = curView`.
2. Store locally: `prepareQC ← m.justify`
3. Send `voteMsg(pre-commit, m.justify.node, ⊥)` to `leader(curView)`.
   The vote contains `partialSig = tsign_r(⟨pre-commit, curView, h(m.justify.node)⟩)`.

---

### Phase 3: Commit

**Leader actions:**

1. Wait for `(n - f)` pre-commit votes for `curView`:
   `V = { v | v.type = pre-commit ∧ v.viewNumber = curView }`
2. Combine votes into `precommitQC`:
   `precommitQC = QC(V)`
3. Broadcast `Msg(commit, ⊥, precommitQC)` to all replicas.

**Replica actions (upon receiving commit message `m` from `leader(curView)`):**

1. Verify `m.type = commit` and `m.justify.type = pre-commit` and
   `m.justify.viewNumber = curView`.
2. **Set the lock:**
   `lockedQC ← m.justify`
   This is the critical safety anchor. A replica locked on `precommitQC` will not vote
   for any conflicting branch unless it sees a QC with a strictly higher view number.
3. Send `voteMsg(commit, m.justify.node, ⊥)` to `leader(curView)`.
   The vote contains `partialSig = tsign_r(⟨commit, curView, h(m.justify.node)⟩)`.

---

### Phase 4: Decide

**Leader actions:**

1. Wait for `(n - f)` commit votes for `curView`:
   `V = { v | v.type = commit ∧ v.viewNumber = curView }`
2. Combine votes into `commitQC`:
   `commitQC = QC(V)`
3. Broadcast `Msg(decide, ⊥, commitQC)` to all replicas.

**Replica actions (upon receiving decide message `m` from `leader(curView)`):**

1. Verify `m.type = decide` and `m.justify.type = commit` and
   `m.justify.viewNumber = curView`.
2. Execute all commands in the branch led by `m.justify.node` that have not been
   executed yet (walk parent links from `m.justify.node` toward the root, executing
   in order from oldest to newest).
3. Send responses to clients.
4. Increment `viewNumber` and enter the next view.

**Happy path outcome:** One command (or batch) committed. Authenticator complexity:
`O(n)` per phase × 4 phases = `O(n)` total per view.

---

## 4. Path 2 — Timeout and View Change

**Trigger:** A replica is waiting for a message in any phase of `curView` and the
`nextView(curView)` timer fires before the expected message arrives.

**This path handles leader failure, network delay, and slow replicas.**

---

### Timer behavior

Every replica maintains a timeout timer upon entering each view. The timer implementation
is left to the application (the paper suggests exponential backoff — see Path 5 for
details). When the timer fires in any phase, the replica:

1. Aborts all waiting operations in the current view.
2. Sends a `new-view` message to the leader of the **next** view:
   `send Msg(new-view, ⊥, prepareQC) to leader(curView + 1)`
   where `prepareQC` is the highest prepare QC this replica has seen so far.
   If the replica has never seen a prepare QC, the `justify` field is `⊥`.
3. Increments `viewNumber` and begins waiting in the new view.

**Note:** A replica that successfully completes the decide phase (Path 1) also sends a
`new-view` message to `leader(curView + 1)` before incrementing its view. This means
`new-view` messages serve double duty: they carry the transition signal both for timed-out
replicas and for replicas that finished normally.

---

### New leader startup sequence

When a replica becomes `leader(curView)`, it executes the prepare phase leader logic:

1. Wait for `(n - f)` `new-view` messages:
   `M = { m | m.type = new-view ∧ m.viewNumber = curView - 1 }`
2. Select `highQC` as the justify field from the message with the highest `viewNumber`:
   `highQC = argmax_{m ∈ M} { m.justify.viewNumber }.justify`
3. Proceed with the prepare phase as in Path 1.

**Key linearity property:** Unlike PBFT, the new leader does not need to collect and relay
a proof consisting of QCs from `(n - f)` replicas. It simply picks the highest QC it
received. This reduces the view-change authenticator cost from `O(n²)` or `O(n³)` to
`O(n)`.

**Safety of `highQC`:** Because `highQC` is the highest among `(n - f)` replicas, and
any commit decision in a prior view required `(n - f)` commit votes, any two such quorums
must overlap in at least one correct replica. That replica would have sent its
`prepareQC` in its `new-view` message, ensuring the leader sees it.

---

### Incumbent leader optimization

An incumbent leader (one that was already leader in the previous view and is still leader)
may skip collecting `new-view` messages and instead use its own highest `prepareQC` as
`highQC`. This avoids one round-trip at the cost of potentially missing a higher QC held
by another replica. This optimization is safe because the liveness rule in `safeNode`
handles the case where a replica has a higher lock.

---

## 5. Path 3 — Faulty or Byzantine Leader

A Byzantine leader may behave arbitrarily: send conflicting proposals, send nothing, send
messages with invalid QCs, send messages to only a subset of replicas, or selectively
delay messages. The protocol handles all of these cases through two mechanisms.

---

### Case A: Equivocating leader (conflicting proposals)

The leader sends two different `prepare` messages in the same view with conflicting nodes.

**Why this cannot produce two committed values:**

- A valid QC requires `(n - f) = 2f + 1` partial signatures, all on the same
  `⟨type, viewNumber, node⟩` tuple.
- If two conflicting QCs existed for the same `(type, viewNumber)`, then by pigeonhole
  there would be a correct replica that voted twice in the same phase of the same view.
- This is impossible: the pseudocode allows each replica to vote at most once per phase
  per view.
- **Lemma 1** (formally): For any valid `qc1`, `qc2` where `qc1.type = qc2.type` and
  `qc1.node` conflicts with `qc2.node`, we have `qc1.viewNumber ≠ qc2.viewNumber`.

**Implementation implication:** A replica must enforce the single-vote rule strictly.
Once it sends a vote for a given `(type, viewNumber)`, it must not send another vote for
the same `(type, viewNumber)` regardless of what any leader claims.

---

### Case B: Silent or crashed leader (no messages sent)

The leader sends no messages in `curView`, or sends messages too slowly.

**Protocol response:**
- Replicas time out via `nextView(curView)` and enter Path 2 (view change).
- The new leader for `curView + 1` collects `new-view` messages and proceeds.
- No special detection of the faulty leader is required. Timeout is sufficient.

**Implementation implication:** The timeout mechanism must be reliable. Every phase wait
must be guarded by a timer. The timer should be reset upon entering each new view.

---

### Case C: Leader sends invalid QC

The leader sends a `pre-commit`, `commit`, or `decide` message whose `justify` field
contains an invalid or mismatched QC.

**Protocol response:**
- Replicas verify every incoming QC by calling `tverify`. If verification fails, the
  message is discarded.
- The replica continues waiting. If the timer fires before a valid message arrives,
  it triggers a view change.

**Implementation implication:** Every QC received from the leader must be verified before
being stored in `prepareQC` or `lockedQC`.

---

### Case D: Leader sends messages to only a subset of replicas

The leader selectively sends valid messages to some replicas and not others, attempting
to split the quorum.

**Protocol response:**
- Replicas that do not receive a message time out and initiate a view change.
- Those that do receive and vote will not form a quorum unless `(n - f)` replicas respond.
  If fewer than `(n - f)` replicas vote, the leader cannot form a QC and the view
  progresses without a commit.
- Safety is preserved because a partial quorum cannot produce a valid threshold signature.

---

## 6. Path 4 — Replica Locked on Stale Branch (Liveness Recovery)

**Background:** The lock (`lockedQC`) is set during the commit phase. A replica that
voted commit in view `v` on node `b` sets `lockedQC` to the `precommitQC` for `b`.
If the view then fails to complete (no decide message arrives), the replica carries
this lock into future views.

**The problem:** A future leader may propose a node that extends a different branch. A
replica locked on `b` would normally reject this proposal under the safety rule. If this
situation is not handled, the system can stall indefinitely.

**The solution:** The `safeNode` predicate contains two disjunctive conditions:

```
safeNode(node, qc):
  return (node extends from lockedQC.node)          -- line 26: safety rule
      OR (qc.viewNumber > lockedQC.viewNumber)       -- line 27: liveness rule
```

---

### Detailed mechanics of liveness recovery

**Why it is safe to override a lock:**

- When a replica is locked on `precommitQC` for node `b` in view `v`, by **Lemma 3**:
  at least `f + 1` correct replicas voted for the matching `prepareQC` for `b`. They
  sent this `prepareQC` in their `new-view` messages.
- The next leader collects `(n - f)` `new-view` messages. Since `f + 1 ≤ n - f` (given
  `n = 3f + 1`), at least one of the `(n - f)` messages comes from a correct replica
  that knows about the `prepareQC` matching the lock.
- Therefore the leader's `highQC` will be at least as high as the locked QC's view.
- The liveness rule in `safeNode` then fires: `qc.viewNumber > lockedQC.viewNumber`
  is satisfied (strictly greater, because the leader must be proposing a new view), so
  the locked replica can safely vote.

**Why overriding the lock cannot break safety:**

- The safety rule exists to prevent a replica from voting for a branch that conflicts
  with something that may already be committed.
- The three-phase structure ensures that before anything is committed, there is a
  `precommitQC` phase between `prepareQC` and `commitQC`. This extra phase creates the
  window in which the `f + 1` correct replicas send their `prepareQC` in `new-view`
  messages, guaranteeing the next leader sees it.
- A two-phase protocol lacks this guarantee (see Path 6 in the companion notes and the
  livelessness example in Section 4.4 of the paper). With two phases, the locked replica
  might be the only one holding the highest QC, so the next leader can never discover
  it — and the liveness rule cannot be safely applied.

**Implementation sequence for stale-lock recovery:**

1. Replica `r` is locked: `r.lockedQC = precommitQC` for node `b` from view `v`.
2. New view `v' > v` begins. New leader proposes node `b'` that conflicts with `b`, with
   `justify = highQC` where `highQC.viewNumber = v'' ≥ v`.
3. Replica `r` receives the prepare message and evaluates `safeNode(b', highQC)`:
   - Safety rule: `b'` does not extend `b` → **false**.
   - Liveness rule: `highQC.viewNumber > lockedQC.viewNumber` → **true if `v'' > v`**.
4. `safeNode` returns `true`. Replica `r` votes for `b'` in the prepare phase.
5. Protocol proceeds normally on the new branch.

**Note on the liveness rule condition:** The liveness rule requires `strictly greater`,
not `greater than or equal`. If the leader re-proposes the same view (which should not
happen in a correctly rotating leader scheme), the liveness rule would not fire, forcing
reliance on the safety rule. Implementations should ensure view numbers are strictly
monotonically increasing.

---

## 7. Path 5 — Pre-GST Network Partition

**Context:** Before GST, the network is asynchronous. Messages may be delayed arbitrarily.
The FLP impossibility result (Fischer, Lynch, Paterson 1985) proves that no deterministic
protocol can guarantee progress in a fully asynchronous model with even one faulty process.
HotStuff accepts this: it guarantees **safety always** but only guarantees **liveness
after GST**.

---

### Safety during asynchronous periods

Safety holds unconditionally because:
- The `safeNode` predicate is evaluated locally by each replica using only its own state.
- The lock (`lockedQC`) is only overridden when justified by a QC with a higher view
  number. No message timing can cause a replica to accept a conflicting proposal that
  would break the invariant.
- QC formation requires threshold signatures, which require `(n - f)` partial signatures.
  An adversary controlling only `f` Byzantine replicas cannot produce a valid QC on its
  own, regardless of message scheduling.
- Theorem 2's proof does not depend on timing — it depends only on the structure of
  locked QCs and the quorum intersection property, both of which hold regardless of
  message delays.

**Implementation implication:** A replica must never skip the `safeNode` check or QC
verification, even if it believes the network is currently synchronous.

---

### Behavior during asynchronous periods

- Replicas time out and advance views continuously.
- New-view messages are sent, but the leader may or may not collect `(n - f)` of them
  before its own timer fires.
- Views advance without any commits. This is expected and correct.
- No invariant is violated. The system is simply not making progress.

---

### Liveness recovery after GST

**Theorem 4** (paper): After GST, there exists a bounded duration `T_f` such that if all
correct replicas remain in the same view `v` during `T_f` and the leader for `v` is
correct, then a decision is reached.

**How to guarantee this in practice:**

The `nextView` timer must use **exponential backoff**:
1. Maintain a timeout interval `τ`, initially some base value.
2. Upon entering a new view, start a timer for `τ`.
3. If the timer fires without a decision, double `τ` and call `nextView`.
4. If a decision is reached, reset `τ` to the base value (optional optimization).

**Why exponential backoff works:**
- After GST, all correct replicas' timers will eventually have an overlap window of
  at least `T_f` where they are all in the same view at the same time.
- During this overlap, if the leader is correct, it can drive a decision in time bounded
  by `4Δ` (four phases, each taking at most `Δ` after GST).
- Exponential backoff guarantees this overlap will eventually occur.

**`T_f` is bounded by:** The time for four complete message round-trips at maximum
network delay `Δ` after GST, plus the time for the leader to form each QC. In practice
`T_f = O(Δ)`.

**Leader rotation:** The `leader(viewNumber)` function must eventually cycle through all
correct replicas, ensuring that some view will have a correct leader during the overlap
window. A simple round-robin mapping `leader(v) = replica[(v - 1) mod n]` satisfies this.

---

## 8. Path 7 — Quorum Stall (Fault Threshold Exceeded, Liveness Lost)

> **Warning:** This path and Paths 8–9 describe failure modes that occur when the
> Byzantine fault count exceeds `f`. These are outside the protocol's design scope and
> correctness guarantees. No recovery is possible within the protocol itself.

**Trigger:** The number of Byzantine or crashed replicas exceeds `f`, so the number of
correct live replicas falls below `n - f = 2f + 1`.

---

### Mechanism

- Every phase requires `(n - f)` votes to form a QC.
- If fewer than `n - f` correct replicas are available to vote, no quorum can ever be
  assembled.
- The leader waits indefinitely at whichever phase it is in.
- `nextView` timers fire on replicas that are still live, advancing views.
- Each new leader also waits for `(n - f)` `new-view` messages. If fewer than `n - f`
  replicas are live, this wait also never completes.
- The system enters an infinite loop of view advancements with zero commits.

### Observable symptoms

- Continuously incrementing view numbers with no commits.
- Leaders timing out at the prepare phase (waiting for new-view messages) before even
  broadcasting a proposal.
- If some but not all phases can be reached (e.g., `n - f - 1` correct replicas), the
  leader may receive enough new-view messages to broadcast a prepare message, but
  cannot collect enough prepare votes to form `prepareQC`. The stall point shifts to
  a later phase but the outcome is the same.

### Safety status

- **Safety is preserved.** No incorrect value is committed. The system freezes rather
  than corrupts.
- This makes Path 7 the least severe of the three over-threshold failure modes.

### Recovery requirements

Recovery is impossible within the protocol. External mechanisms required:
1. **Reconfiguration:** Replace crashed/Byzantine replicas with new correct ones, restoring
   `n ≥ 3f + 1` where `f` is the new fault count.
2. **State transfer:** New replicas must be bootstrapped with the current committed log
   state from existing correct replicas before rejoining.
3. **View reset:** After reconfiguration, all correct replicas must agree on a starting
   view number for the new configuration.

---

## 9. Path 8 — Forged QC (Fault Threshold Exceeded, Safety Violated)

**Trigger:** The number of Byzantine replicas exceeds `f`, giving the adversary access
to more than `f` private signing keys. Combined with partial signatures collected from
honest replicas during normal operation, the adversary may be able to assemble
`k = 2f + 1` partial signatures for a fraudulent message.

---

### Mechanism

The threshold signature scheme requires `k = 2f + 1` partial signatures. With `f + 1`
or more Byzantine replicas, the adversary controls `f + 1` private keys directly.
It needs only `f` more partial signatures from honest replicas. These can be obtained
because honest replicas legitimately vote (and thus produce partial signatures) during
the prepare phase of any view in which they accept a proposal.

**Attack sequence:**

1. Leader (possibly Byzantine or colluding) broadcasts a valid prepare message for node
   `b` in view `v`.
2. `(n - f)` honest replicas accept it (passes `safeNode`) and send prepare votes,
   each containing `tsign_r(⟨prepare, v, h(b)⟩)`.
3. The adversary also has a Byzantine leader broadcast a conflicting prepare message
   for node `b'` in a carefully chosen view `v'`.
4. Some honest replicas (those for whom `safeNode(b', ...)` passes due to the liveness
   rule) also vote for `b'`.
5. The adversary uses its `f + 1` Byzantine keys plus `f` collected honest partial
   signatures (from step 2 or step 4) to assemble a fraudulent threshold signature for
   `b'` at a phase and view that no honest replica actually certified.
6. This forged QC is presented to honest replicas in `pre-commit` or `commit` messages.
7. Honest replicas cannot distinguish the forged QC from a legitimate one, because the
   threshold signature is mathematically valid.

### Safety violation produced

- **Lemma 1 breaks:** Two conflicting nodes `b` and `b'` can now both have valid QCs
  at the same `(type, viewNumber)` — something that requires a correct replica to have
  voted twice, which the adversary has circumvented by forging one QC directly.
- **Theorem 2 no longer holds:** Two conflicting nodes can both accumulate the necessary
  QC chains to be committed, potentially at different correct replicas.
- **Result:** Correct replica `r1` executes command `cmd_b` and correct replica `r2`
  executes command `cmd_{b'}` at the same sequence position. The replicated state
  machine has diverged permanently.

### Observable symptoms

- Different correct replicas report different responses to clients for the same request.
- The committed log diverges across replicas.
- Subsequent commands may execute correctly on each individual replica's branch, but
  the branches are inconsistent with each other.

### Recovery requirements

- **Safety has been permanently violated.** There is no in-protocol recovery.
- Requires checkpoint comparison across replicas, identification of the divergence point,
  rollback of all replicas to the last consistent checkpoint, and Byzantine replica
  identification and removal before restarting.

---

## 10. Path 9 — Quorum Intersection Breakdown (Fault Threshold Exceeded)

**Trigger:** The number of Byzantine replicas exceeds `f`, destroying the quorum
intersection property that all correctness proofs depend on.

---

### The quorum intersection property

In a correct system with `n = 3f + 1` and at most `f` Byzantine replicas:
- Any two quorums of size `n - f = 2f + 1` must overlap in at least `f + 1` replicas.
- Of those `f + 1` overlapping replicas, at most `f` are Byzantine.
- Therefore **at least one overlapping replica is correct**.

This single correct replica in the intersection is the witness that Theorem 2's proof
relies on. It is the replica `r` that appears in both the commit quorum for `b` and the
first conflicting prepare quorum for `b'`. Its presence guarantees that `safeNode` returns
false for the conflicting proposal, preventing the safety violation.

**When `f` is exceeded:** Two quorums of size `n - f` may overlap entirely within the
set of Byzantine replicas (the overlap is `f + 1` nodes, all of which can be Byzantine
if there are more than `f` Byzantine replicas). The correct witness no longer exists.

---

### Mechanism

**Scenario — leader fed false `highQC`:**

1. Byzantine replicas holding the `new-view` role send fabricated or selectively withheld
   `new-view` messages to the new leader.
2. The new leader collects `(n - f)` `new-view` messages. If more than `f` of these are
   from Byzantine replicas, the `highQC` the leader selects may be artificially low —
   hiding the true highest lock held by correct replicas.
3. The leader proposes a branch that conflicts with what some honest replicas are locked
   on, using a `justify` QC that does not satisfy the liveness rule for those replicas.
4. Those locked replicas correctly reject the proposal (their `safeNode` returns false
   for both rules).
5. But the remaining `(n - f)` quorum can be formed by Byzantine replicas plus the
   fraction of correct replicas whose lock is lower.
6. This can produce a `prepareQC` for a conflicting branch. If this escalates through
   pre-commit to commit, a safety violation occurs without any forged signatures —
   purely through adversarial message routing.

**Why the proofs break:**

- Theorem 2's proof identifies a specific correct replica `r` in the intersection of two
  quorums. This `r` is the one that cast a commit vote for `b` and later voted in the
  prepare phase for `b'`, and the proof shows `safeNode` would have rejected `b'` for `r`.
- If no such correct `r` exists in the intersection, the proof has no valid witness and
  the conclusion does not follow.

### Observable symptoms

This path is subtler than Path 8 and may produce intermittent rather than immediate
failures:
- Correct replicas with higher locks correctly reject proposals; others vote.
- The system may appear to make progress from the leader's perspective while some
  correct replicas fall behind permanently.
- Eventually manifests as diverged committed logs, similar to Path 8, but traceable to
  quorum routing rather than signature forgery.

### Recovery requirements

Same as Path 8: external checkpoint comparison, rollback, Byzantine replica removal,
and reconfiguration before restart.

---

## 11. Invariants Every Implementation Must Preserve

The following invariants must hold in any correct implementation of Basic HotStuff.
Violating any of them may compromise safety or liveness.

### Safety invariants (must hold always, even pre-GST)

**INV-1: Single vote per phase per view**
A replica sends at most one vote of each type per `(type, viewNumber)` pair.
Once `voteMsg(prepare, node, ⊥)` is sent for view `v`, no second prepare vote
for view `v` is sent regardless of what the leader requests.

**INV-2: Lock monotonicity**
`lockedQC.viewNumber` is non-decreasing. A replica only updates `lockedQC` when the
new QC has a strictly higher view number than the current lock:
`new_precommitQC.viewNumber > lockedQC.viewNumber` must hold before updating.

**INV-3: `safeNode` is always evaluated before voting**
A replica never sends a prepare vote without first verifying both:
- `m.node` extends from `m.justify.node` (structural check).
- `safeNode(m.node, m.justify)` returns true (safety + liveness check).

**INV-4: QC verification before storage**
A replica never stores a QC in `prepareQC` or `lockedQC` without first calling
`tverify` on it.

**INV-5: Phase ordering is respected**
A replica processes phases strictly in order within a view: prepare → pre-commit →
commit → decide. A message from a later phase cannot be used to update state
(e.g., set `lockedQC`) if the prior phase messages have not been processed.

### Liveness invariants (must hold after GST)

**INV-6: Timer guards every phase wait**
Every `wait for` operation is guarded by a timer. No replica blocks indefinitely
in any single phase. The timer must fire even if no messages arrive.

**INV-7: `new-view` is always sent on view exit**
Whenever a replica exits a view (whether by completing decide, or by timer expiry),
it sends `Msg(new-view, ⊥, prepareQC)` to `leader(curView + 1)` before incrementing
`viewNumber`.

**INV-8: Timer uses exponential backoff**
The timeout interval at least doubles on each consecutive failed view. This guarantees
that all correct replicas eventually have a sufficiently long overlap in the same view
to allow a decision.

**INV-9: Leader rotation covers all replicas**
The `leader(viewNumber)` function maps to every correct replica infinitely often. A
simple modular round-robin satisfies this.

---

## 12. Path Interaction Summary Table

| Path | Trigger condition | Safety preserved | Liveness preserved | Recovery within protocol |
|---|---|---|---|---|
| 1 — Happy path | Correct leader, synced replicas, post-GST | Yes | Yes | N/A |
| 2 — View change | Timer fires in any phase | Yes | Yes (post-GST) | Automatic via new-view |
| 3A — Equivocating leader | Byzantine leader sends conflicting proposals | Yes (Lemma 1) | Yes (next view) | Automatic via timeout |
| 3B — Silent leader | Byzantine or crashed leader sends nothing | Yes | Yes (post-GST) | Automatic via timeout |
| 3C — Invalid QC | Leader sends unverifiable QC | Yes (tverify rejects) | Yes (post-GST) | Automatic via timeout |
| 3D — Partial broadcast | Leader sends to subset only | Yes | Yes (post-GST) | Automatic via timeout |
| 4 — Stale lock | Replica locked on old branch, new higher QC exists | Yes | Yes (post-GST, Lemma 3) | Automatic via liveness rule in safeNode |
| 5 — Pre-GST partition | Asynchronous network before GST | Yes | No (by FLP impossibility) | Automatic after GST via backoff |
| 7 — Quorum stall | Faulty count > f, correct count < n−f | Yes (nothing commits) | **No — permanent** | Requires external reconfiguration |
| 8 — Forged QC | Faulty count > f, adversary forges threshold sig | **No — violated** | Irrelevant | Requires checkpoint + rollback |
| 9 — Intersection loss | Faulty count > f, quorums share no correct replica | **No — violated** | **No — permanent** | Requires checkpoint + rollback |

---

## Appendix: Key Lemmas and Theorems Referenced

**Lemma 1:** For any valid `qc1`, `qc2` where `qc1.type = qc2.type` and `qc1.node`
conflicts with `qc2.node`, `qc1.viewNumber ≠ qc2.viewNumber`.

*Proof sketch:* Two QCs for conflicting nodes in the same view and phase would require
a correct replica to vote twice in the same phase — forbidden by the single-vote rule.

**Theorem 2 (Safety):** If `w` and `b` are conflicting nodes, they cannot both be
committed by any correct replica.

*Proof sketch:* By contradiction. If both were committed, there exist commit QCs for
each in views `v1 < v2`. Let `vs` be the lowest view above `v1` where a prepare QC for
a branch conflicting with `w` exists. A correct replica `r` in the intersection of the
commit quorum for `w` and the prepare quorum for the conflicting branch at `vs` must
have voted in both. But `r` is locked on the branch containing `w` from view `v1`, and
neither disjunct of `safeNode` can be satisfied at view `vs` (safety rule fails because
the branch conflicts; liveness rule fails because the QC view would need to be above
`v1` which contradicts the minimality of `vs`). Contradiction.

**Lemma 3:** If a correct replica is locked such that `lockedQC = precommitQC`, then at
least `f + 1` correct replicas voted for some `prepareQC` matching `lockedQC`.

*Proof sketch:* Setting `lockedQC` requires `(n - f)` pre-commit votes, which requires
a prior `(n - f)` prepare votes. Of those `(n - f)` prepare voters, at least `f + 1`
are correct.

**Theorem 4 (Liveness):** After GST, there exists a bounded `T_f` such that if all
correct replicas remain in view `v` during `T_f` and `leader(v)` is correct, a decision
is reached.

*Proof sketch:* The leader collects `(n - f)` new-view messages including at least one
from a correct replica holding the highest lock. All correct replicas satisfy `safeNode`
(liveness rule fires for any stale locks). All four phases complete within `O(Δ)` each.

---

*Sources: Yin, Malkhi, Reiter, Golan Gueta, Abraham. "HotStuff: BFT Consensus with
Linearity and Responsiveness." PODC 2019. And the extended version: "HotStuff: BFT
Consensus in the Lens of Blockchain." arXiv:1803.05069v6, 2019.*
