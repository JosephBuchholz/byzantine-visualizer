import AdversaryReplica from "./AdversaryReplica";
import DefaultReplica from "./DefaultReplica";
import LeaderReplica from "./LeaderReplica";
import type { ReplicaType } from "./ReplicaObject";

export default function makeReplica(type: ReplicaType) {
  switch (type) {
    case "default":
      return new DefaultReplica("default");
    case "leader":
      return new LeaderReplica("leader");
    case "adversary":
      return new AdversaryReplica("adversary");
  }
}
