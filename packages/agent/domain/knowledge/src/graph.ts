import graphData from "../generated/graph.json" with { type: "json" };

export type GraphNodeKind =
  | "item"
  | "block"
  | "entity"
  | "structure"
  | "dimension"
  | "station"
  | "capability"
  | "action";

export type GraphEdgeType =
  | "produce"
  | "consume"
  | "drop"
  | "loot"
  | "trade"
  | "harvest"
  | "tool"
  | "location"
  | "capability"
  | "alternative";

export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly key: string;
  readonly label?: string;
  readonly obtainable?: boolean;
  readonly creativeOnly?: boolean;
  readonly reason?: string;
  readonly variants?: Readonly<Record<string, string>>;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly type: GraphEdgeType;
  readonly group: "AND" | "OR";
  readonly quantity: number;
  readonly conditions: readonly string[];
  readonly cost: number;
  readonly risk: "none" | "low" | "medium" | "high";
  readonly probability: number;
  readonly evidence: readonly string[];
}

export interface KnowledgeGraphData {
  readonly meta: {
    readonly schemaVersion: 1;
    readonly minecraftVersion: string;
    readonly source: string;
    readonly summaryTag: string;
    readonly dataTag: string;
    readonly dataVersion: number;
    readonly generatedFrom: string;
  };
  readonly counts: {
    readonly items: number;
    readonly blocks: number;
    readonly entities: number;
    readonly dimensions: number;
    readonly structures: number;
    readonly nodes: number;
    readonly edges: number;
    readonly reachableItems: number;
  };
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface AcquisitionPath {
  readonly item: string;
  readonly action: string;
  readonly evidence: readonly string[];
  readonly inputs: readonly AcquisitionPath[];
}

export const KNOWLEDGE_GRAPH: KnowledgeGraphData = graphData as KnowledgeGraphData;

const nodesById = new Map(KNOWLEDGE_GRAPH.nodes.map((node) => [node.id, node] as const));
const edgesByFrom = new Map<string, GraphEdge[]>();
const edgesByTo = new Map<string, GraphEdge[]>();
for (const edge of KNOWLEDGE_GRAPH.edges) {
  const from = edgesByFrom.get(edge.from) ?? [];
  from.push(edge);
  edgesByFrom.set(edge.from, from);
  const to = edgesByTo.get(edge.to) ?? [];
  to.push(edge);
  edgesByTo.set(edge.to, to);
}

export function graphNode(id: string): GraphNode | null {
  return nodesById.get(id) ?? null;
}

export function itemNode(item: string): GraphNode | null {
  return graphNode(`item:${normalize(item)}`);
}

export function outgoingEdges(id: string, type?: GraphEdgeType): readonly GraphEdge[] {
  const edges = edgesByFrom.get(id) ?? [];
  return type === undefined ? edges : edges.filter((edge) => edge.type === type);
}

export function incomingEdges(id: string, type?: GraphEdgeType): readonly GraphEdge[] {
  const edges = edgesByTo.get(id) ?? [];
  return type === undefined ? edges : edges.filter((edge) => edge.type === type);
}

/**
 * Every competing acquisition action for an item, risk-sorted. The planner
 * treats this as a preference list; it never assumes the first row is safe
 * without checking the action's guards.
 */
export function acquisitionActions(item: string): readonly GraphEdge[] {
  const id = `item:${normalize(item)}`;
  return [...(edgesByTo.get(id) ?? [])]
    .filter((edge) => ["produce", "drop", "loot", "trade"].includes(edge.type))
    .sort(
      (left, right) =>
        riskRank(left.risk) - riskRank(right.risk) ||
        left.cost - right.cost ||
        right.probability - left.probability ||
        left.from.localeCompare(right.from),
    );
}

/**
 * Returns one conservative path for an item along AND inputs, choosing an OR
 * edge only when one choice is reachable. Paths are bounded and cycle-safe so
 * callers can use them for explanations and acceptance checks.
 */
export function acquisitionPath(
  item: string,
  options: { readonly maxDepth?: number } = {},
): AcquisitionPath | null {
  return resolve(normalize(item), 0, new Set(), options.maxDepth ?? 12);
}

export function allIronAcceptancePaths(): Readonly<Record<string, AcquisitionPath | null>> {
  const result: Record<string, AcquisitionPath | null> = {};
  for (const item of [
    "minecraft:iron_pickaxe",
    "minecraft:iron_sword",
    "minecraft:iron_helmet",
    "minecraft:iron_chestplate",
    "minecraft:iron_leggings",
    "minecraft:iron_boots",
  ]) {
    result[item] = acquisitionPath(item);
  }
  return result;
}

export interface GraphValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Runtime-independent structural validation. The generator also validates
 * before writing; this guard keeps a stale or hand-edited generated file from
 * silently entering the Agent.
 */
export function validateKnowledgeGraph(
  graph: KnowledgeGraphData = KNOWLEDGE_GRAPH,
): GraphValidation {
  const errors: string[] = [];
  if (graph.counts.items !== 1255) errors.push(`item count ${graph.counts.items}`);
  if (graph.counts.blocks !== 1003) errors.push(`block count ${graph.counts.blocks}`);
  if (graph.counts.entities !== 124) errors.push(`entity count ${graph.counts.entities}`);
  if (graph.counts.dimensions !== 3) errors.push(`dimension count ${graph.counts.dimensions}`);
  if (graph.nodes.length !== graph.counts.nodes) errors.push("node count mismatch");
  if (graph.edges.length !== graph.counts.edges) errors.push("edge count mismatch");
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) errors.push(`missing edge source ${edge.from}`);
    if (!ids.has(edge.to)) errors.push(`missing edge target ${edge.to}`);
    if (edge.quantity < 1) errors.push(`non-positive quantity ${edge.from}->${edge.to}`);
    if (edge.probability <= 0 || edge.probability > 1) {
      errors.push(`invalid probability ${edge.from}->${edge.to}`);
    }
  }
  for (const item of graph.nodes.filter((node) => node.kind === "item")) {
    if (item.creativeOnly === true) continue;
    if (item.obtainable === true && acquisitionActions(item.key).length === 0) {
      errors.push(`obtainable item without action ${item.key}`);
    }
  }
  for (const [item, path] of Object.entries(allIronAcceptancePaths())) {
    if (path === null) errors.push(`no iron path for ${item}`);
    else if (path.evidence.length === 0) errors.push(`iron path lacks evidence for ${item}`);
  }
  return { ok: errors.length === 0, errors };
}

function resolve(
  item: string,
  depth: number,
  stack: Set<string>,
  maxDepth: number,
): AcquisitionPath | null {
  if (depth > maxDepth || stack.has(item)) return null;
  const actionEdges = acquisitionActions(item);
  if (actionEdges.length === 0) return null;
  stack.add(item);
  for (const edge of actionEdges) {
    const inputs = outgoingEdges(edge.from).filter(
      (candidate) => candidate.type === "consume" || candidate.type === "tool",
    );
    const resolvedInputs: AcquisitionPath[] = [];
    let valid = true;
    for (const group of grouped(inputs)) {
      // Any edge in an OR group is a choice; an AND group must supply every
      // required item. Tool edges are AND by construction.
      const choice = group
        .map((candidate) => resolve(candidate.to.replace(/^item:/u, ""), depth + 1, stack, maxDepth))
        .find((candidate) => candidate !== null);
      if (choice === undefined) {
        valid = false;
        break;
      }
      resolvedInputs.push(choice);
    }
    if (!valid) continue;
    stack.delete(item);
    return {
      item,
      action: edge.from,
      evidence: [...edge.evidence, ...actionEdges[0]!.evidence],
      inputs: resolvedInputs,
    };
  }
  stack.delete(item);
  return null;
}

function grouped(edges: readonly GraphEdge[]): GraphEdge[][] {
  const groups = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const key = `${edge.type}:${edge.group}`;
    const list = groups.get(key) ?? [];
    list.push(edge);
    groups.set(key, list);
  }
  return [...groups.values()];
}

function riskRank(risk: GraphEdge["risk"]): number {
  return { none: 0, low: 1, medium: 2, high: 3 }[risk];
}

function normalize(id: string): string {
  const trimmed = id.trim().toLowerCase();
  return trimmed.includes(":") ? trimmed : `minecraft:${trimmed}`;
}
