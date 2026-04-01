import AdversaryReplica from "./AdversaryReplica";
import DefaultReplica from "./DefaultReplica";
import LeaderReplica from "./LeaderReplica";
import type { ReplicaType } from "./ReplicaObject";

export default function makeReplica(type: ReplicaType, onHover?: (id: string) => void) {
  switch (type) {
    case "default":
      return new DefaultReplica("default", onHover);
    case "leader":
      return new LeaderReplica("leader", onHover);
    case "adversary":
      return new AdversaryReplica("adversary", onHover);
  }
}
