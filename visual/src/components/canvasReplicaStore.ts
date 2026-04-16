export type ReplicaLike<TNode extends { destroy: () => void } | null = { destroy: () => void } | null> = {
  id: string;
  konvaNode: TNode;
};

export function upsertReplica<
  TNode extends { destroy: () => void } | null,
  TReplica extends ReplicaLike<TNode>,
>(
  replicas: Map<string, TReplica>,
  nextReplica: TReplica,
  addKonvaNode: (node: TNode) => void,
) {
  const previousReplica = replicas.get(nextReplica.id);
  if (previousReplica && previousReplica !== nextReplica) {
    previousReplica.konvaNode?.destroy();
  }

  replicas.set(nextReplica.id, nextReplica);
  addKonvaNode(nextReplica.konvaNode);
}

export function removeReplica<TNode extends { destroy: () => void } | null, TReplica extends ReplicaLike<TNode>>(
  replicas: Map<string, TReplica>,
  replicaID: string,
): boolean {
  const replica = replicas.get(replicaID);
  if (!replica) {
    return false;
  }

  replica.konvaNode?.destroy();
  replicas.delete(replicaID);
  return true;
}
