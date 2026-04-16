import type { SimReplica } from "../simulation/simulationManager.ts";
import AdversaryReplica from "./AdversaryReplica";
import DefaultReplica from "./DefaultReplica";

export default function makeReplica(simReplica: SimReplica, onHover?: (id: string) => void) {
  switch (simReplica.type) {
    case "default":
      return new DefaultReplica(simReplica, onHover);
    case "adversary":
      return new AdversaryReplica(simReplica, onHover);
  }
}
