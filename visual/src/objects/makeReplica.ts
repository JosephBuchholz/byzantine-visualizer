import type { SimReplica } from "../simulation/simulationManager";
import AdversaryReplica from "./AdversaryReplica";
import DefaultReplica from "./DefaultReplica";
import LeaderReplica from "./LeaderReplica";

export default function makeReplica(simReplica: SimReplica, onHover?: (id: string) => void) {
  switch (simReplica.type) {
    case "default":
      return new DefaultReplica(simReplica, onHover);
    case "leader":
      return new LeaderReplica(simReplica, onHover);
    case "adversary":
      return new AdversaryReplica(simReplica, onHover);
  }
}
