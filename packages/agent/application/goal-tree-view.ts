import type { GoalTaskTree, GoalTreeViewNode } from "@craftmate/contracts";
import type { TaskNode, TaskTreeSnapshot } from "../domain/index.ts";

/**
 * Bounded, read-only projection of the internal behavior tree. The body never
 * receives this shape and the tree engine never reads it back.
 */
export function projectGoalTree(
  snapshot: TaskTreeSnapshot | null,
  now: number,
): GoalTaskTree | null {
  if (snapshot === null) return null;
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node] as const));
  const insertionOrder = new Map(
    snapshot.nodes.map((node, index) => [node.id, index] as const),
  );
  const cursor = byId.get(snapshot.cursorId) ?? null;
  const activePath = pathTo(cursor, byId).slice(-16);
  const nodes = [...snapshot.nodes]
    .sort((left, right) => comparePreorder(left, right, insertionOrder))
    .slice(0, 256)
    .map((node) => viewNode(node));
  return {
    schemaVersion: 2,
    rootId: snapshot.rootId,
    cursorId: snapshot.cursorId,
    pausedNodeId: snapshot.pausedCursorId,
    interruptActive: snapshot.nodes.some(
      (node) => node.kind === "interrupt" && node.state === "active",
    ),
    nodes,
    activePath: activePath.map((node) => ({
      id: node.id,
      intent: node.intent.slice(0, 240),
      state: node.state,
      priority: node.priority,
    })),
    currentNodeId: cursor?.id ?? null,
    currentNodeIntent: cursor?.intent.slice(0, 240) ?? null,
    checkpointAgeMs:
      cursor === null ? 0 : Math.max(0, now - cursor.updatedAt),
    blockedReason:
      cursor?.failureDetail ?? cursor?.reason ?? null,
    targetFamily: cursor?.targetFamily ?? null,
    evidenceRefs: cursor?.successEvidence.slice(-16) ?? [],
    branches: [],
  };
}

function viewNode(node: TaskNode): GoalTreeViewNode {
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    mode: node.mode,
    intent: node.intent.slice(0, 240),
    state: node.state,
    priority: node.priority,
    reason: (node.reason ?? node.failureDetail ?? null)?.slice(0, 600) ?? null,
    evidenceRefs: node.successEvidence.slice(-8),
    attempts: node.failureCount,
    trigger: node.trigger,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function pathTo(
  node: TaskNode | null,
  byId: ReadonlyMap<string, TaskNode>,
): readonly TaskNode[] {
  const path: TaskNode[] = [];
  let current = node;
  while (current !== null) {
    path.unshift(current);
    current = current.parentId === null ? null : byId.get(current.parentId) ?? null;
  }
  return path;
}

/**
 * Nodes created in the same millisecond (a fresh tree builds its stage
 * skeleton in one tick) keep their insertion order instead of falling back
 * to id order, which would reorder stages and milestones semantically.
 */
function comparePreorder(
  left: TaskNode,
  right: TaskNode,
  insertionOrder: ReadonlyMap<string, number>,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return (insertionOrder.get(left.id) ?? 0) - (insertionOrder.get(right.id) ?? 0);
}
