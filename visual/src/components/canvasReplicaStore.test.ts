import { describe, expect, it, vi } from "vitest";
import { removeReplica, upsertReplica, type ReplicaLike } from "./canvasReplicaStore";

describe("canvasReplicaStore", () => {
  it("destroys previous node when upserting same replica id", () => {
    const oldDestroy = vi.fn();
    const nextDestroy = vi.fn();

    const replicas = new Map<string, ReplicaLike>();
    const addKonvaNode = vi.fn();

    upsertReplica(replicas, { id: "node-2", konvaNode: { destroy: oldDestroy } }, addKonvaNode);
    upsertReplica(replicas, { id: "node-2", konvaNode: { destroy: nextDestroy } }, addKonvaNode);

    expect(oldDestroy).toHaveBeenCalledTimes(1);
    expect(nextDestroy).toHaveBeenCalledTimes(0);
    expect(addKonvaNode).toHaveBeenCalledTimes(2);
    expect(replicas.get("node-2")?.konvaNode).toEqual({ destroy: nextDestroy });
  });

  it("removes replica and destroys its node", () => {
    const destroy = vi.fn();
    const replicas = new Map<string, ReplicaLike>();
    replicas.set("node-3", { id: "node-3", konvaNode: { destroy } });

    const removed = removeReplica(replicas, "node-3");
    expect(removed).toBe(true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(replicas.has("node-3")).toBe(false);
  });
});
