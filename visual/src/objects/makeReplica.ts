import type { SimReplica } from "../simulation/simulationManager";
import AdversaryReplica, { ADVERSARY_REPLICA_COLOR } from "./AdversaryReplica";
import DefaultReplica from "./DefaultReplica";
import LeaderReplica from "./LeaderReplica";
import type ReplicaObject from "./ReplicaObject";

export default function makeReplica(simReplica: SimReplica, onHover?: (id: string) => void) {
  if (simReplica.isLeader) {
    const leader = new LeaderReplica(simReplica, onHover);

    if (simReplica.isAdversary) {
      leader.color = ADVERSARY_REPLICA_COLOR;
      leader.spin = true;
    }

    return leader;
  } else if (simReplica.isAdversary) {
    return new AdversaryReplica(simReplica, onHover);
  } else {
    return new DefaultReplica(simReplica, onHover);
  }
}

export function makeReplicaFromPrevious(
  simReplica: SimReplica,
  previousReplica: ReplicaObject,
  onHover?: (id: string) => void,
) {
  const newReplica = makeReplica(simReplica, onHover);
  newReplica.setPosition(previousReplica.position);
  return newReplica;
}
