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

export interface AcquisitionNode {
  readonly key: string;
  readonly kind: "item" | "action" | "station";
  readonly target: string;
  readonly quantity: number;
  readonly group: "AND" | "OR";
  readonly evidence: readonly string[];
  readonly children: readonly AcquisitionNode[];
}

export interface AcquisitionTreeOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  /** Current stock; used to prefer an OR branch that is already available. */
  readonly available?: (item: string) => number;
  /** Stations currently reachable. Undefined keeps station filtering disabled. */
  readonly stations?: readonly string[];
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

/**
 * Materialises the selected acquisition branch as an AND/OR tree. This is the
 * planner-facing form: item nodes are goals, action nodes are sources, and
 * station nodes are preconditions that do not consume inventory.
 */
export function acquisitionTree(
  item: string,
  quantity = 1,
  options: AcquisitionTreeOptions = {},
): AcquisitionNode | null {
  const stations =
    options.stations === undefined
      ? null
      : new Set(options.stations.map(stationName));
  const context: TreeContext = {
    maxDepth: options.maxDepth ?? 10,
    maxNodes: options.maxNodes ?? 128,
    available: options.available ?? (() => 0),
    stations,
    nodes: 0,
  };
  return buildItemTree(normalize(item), Math.max(1, quantity), 0, new Set(), context);
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
    const required = inputs.filter((candidate) => candidate.group === "AND");
    const choices = grouped(inputs.filter((candidate) => candidate.group === "OR"));
    const resolvedInputs: AcquisitionPath[] = [];
    let valid = true;
    for (const candidate of required) {
      const resolved = resolve(
        candidate.to.replace(/^item:/u, ""),
        depth + 1,
        stack,
        maxDepth,
      );
      if (resolved === null) {
        valid = false;
        break;
      }
      resolvedInputs.push(resolved);
    }
    for (const group of choices) {
      const choice = group
        .map((candidate) =>
          resolve(
            candidate.to.replace(/^item:/u, ""),
            depth + 1,
            stack,
            maxDepth,
          ),
        )
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

interface TreeContext {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly available: (item: string) => number;
  readonly stations: ReadonlySet<string> | null;
  nodes: number;
}

function buildItemTree(
  item: string,
  quantity: number,
  depth: number,
  stack: Set<string>,
  context: TreeContext,
): AcquisitionNode | null {
  if (depth > context.maxDepth || stack.has(item)) return null;
  if (context.nodes >= context.maxNodes) return null;
  const key = `item:${item}`;
  context.nodes++;
  if (context.available(item) >= quantity) {
    return {
      key,
      kind: "item",
      target: item,
      quantity,
      group: "AND",
      evidence: [`inventory has ${quantity} ${item}`],
      children: [],
    };
  }
  stack.add(item);
  const actions = [...acquisitionActions(item)].sort(
    (left, right) =>
      actionStationScore(right, context) - actionStationScore(left, context) ||
      actionStockScore(right, context) - actionStockScore(left, context) ||
      Number(context.available(right.to) > 0) -
        Number(context.available(left.to) > 0) ||
      riskRank(left.risk) - riskRank(right.risk) ||
      left.cost - right.cost,
  );
  for (const edge of actions) {
    const produced = buildActionTree(edge, quantity, depth, stack, context);
    if (produced !== null) {
      stack.delete(item);
      return produced;
    }
  }
  stack.delete(item);
  return null;
}

function buildActionTree(
  edge: GraphEdge,
  quantity: number,
  depth: number,
  stack: Set<string>,
  context: TreeContext,
): AcquisitionNode | null {
  if (context.nodes >= context.maxNodes) return null;
  const actionKind = acquireKind(edge);
  if (actionKind === null) return null;
  const output = outgoingEdges(edge.from).find(
    (candidate) => candidate.type === "produce" && candidate.to === edge.to,
  );
  const outputCount = Math.max(1, output?.quantity ?? edge.quantity);
  const batches = Math.max(1, Math.ceil(quantity / outputCount));
  const inputs = outgoingEdges(edge.from).filter(
    (candidate) =>
      candidate.type === "consume" ||
      candidate.type === "tool" ||
      candidate.type === "location",
  );
  /*
   * Fuel is a rate, not one item per output: a single coal smelts several
   * items, and the body's smelt skill owns fuel selection. Tool edges are
   * likewise capability requirements owned by the survival planner. Treat
   * both as optional annotations so a tree does not claim "no iron path"
   * merely because the exact fuel stack is smaller than the output count.
   */
  const required = inputs.filter(
    (candidate) =>
      candidate.type === "consume" &&
      candidate.group === "AND" &&
      !isFuelEdge(candidate),
  );
  const choices = grouped(
    inputs.filter(
      (candidate) =>
        candidate.type === "consume" &&
        candidate.group === "OR" &&
        !isFuelEdge(candidate),
    ),
  );
  const children: AcquisitionNode[] = [];
  for (const candidate of inputs.filter((entry) => entry.type === "location")) {
    const station = stationName(candidate.to);
    if (context.stations !== null && !context.stations.has(station)) return null;
    if (context.nodes >= context.maxNodes) return null;
    context.nodes++;
    children.push({
      key: `station:${candidate.to}`,
      kind: "station",
      target: candidate.to.replace(/^station:/u, ""),
      quantity: batches,
      group: "AND",
      evidence: [...candidate.evidence],
      children: [],
    });
  }
  for (const candidate of inputs.filter(
    (entry) =>
      entry.type === "tool" &&
      context.available(entry.to.replace(/^item:/u, "")) > 0,
  )) {
    if (context.nodes >= context.maxNodes) return null;
    context.nodes++;
    children.push({
      key: candidateInputKey(candidate),
      kind: "item",
      target: candidate.to.replace(/^item:/u, ""),
      quantity: candidate.quantity,
      group: "AND",
      evidence: [...candidate.evidence],
      children: [],
    });
  }
  for (const candidate of inputs.filter(
    (entry) =>
      entry.type === "consume" &&
      isFuelEdge(entry) &&
      entry.group === "AND" &&
      context.available(entry.to.replace(/^item:/u, "")) > 0,
  )) {
    if (context.nodes >= context.maxNodes) return null;
    context.nodes++;
    children.push({
      key: candidateInputKey(candidate),
      kind: "item",
      target: candidate.to.replace(/^item:/u, ""),
      quantity: 1,
      group: "AND",
      evidence: [...candidate.evidence],
      children: [],
    });
  }
  for (const candidate of required) {
    const child = buildItemTree(
      candidate.to.replace(/^item:/u, ""),
      candidate.quantity * batches,
      depth + 1,
      stack,
      context,
    );
    if (child === null) return null;
    children.push(child);
  }
  for (const group of choices) {
    const child = [...group]
      .sort(
        (left, right) =>
          context.available(right.to.replace(/^item:/u, "")) -
            context.available(left.to.replace(/^item:/u, "")) ||
          left.to.localeCompare(right.to),
      )
      .map((candidate) =>
        buildItemTree(
          candidate.to.replace(/^item:/u, ""),
          candidate.quantity * batches,
          depth + 1,
          stack,
          context,
        ),
      )
      .find((candidate) => candidate !== null);
    if (child === undefined) return null;
    children.push(child);
  }
  context.nodes++;
  return {
    key: edge.from,
    kind: "action",
    target: edge.from,
    quantity: batches,
    group: "AND",
    evidence: [...edge.evidence, ...(output?.evidence ?? [])],
    children,
  };
}

function actionStockScore(edge: GraphEdge, context: TreeContext): number {
  const inputs = outgoingEdges(edge.from).filter(
    (candidate) => candidate.type === "consume",
  );
  let score = 0;
  for (const input of inputs) {
    if (input.group === "OR") {
      score += inputs.some(
        (candidate) =>
          candidate.group === "OR" &&
          candidate.quantity === input.quantity &&
          candidate.type === input.type &&
          context.available(candidate.to.replace(/^item:/u, "")) >= candidate.quantity,
      )
        ? 1
        : 0;
    } else {
      score +=
        context.available(input.to.replace(/^item:/u, "")) >= input.quantity
          ? 1
          : 0;
    }
  }
  return score;
}

function actionStationScore(edge: GraphEdge, context: TreeContext): number {
  const stations = context.stations;
  if (stations === null) return 0;
  const locations = outgoingEdges(edge.from).filter(
    (candidate) => candidate.type === "location",
  );
  return locations.every((candidate) =>
    stations.has(stationName(candidate.to)),
  )
    ? 1
    : -1;
}

function isFuelEdge(edge: GraphEdge): boolean {
  return edge.conditions.some((condition) => condition.startsWith("fuel"));
}

function candidateInputKey(edge: GraphEdge): string {
  return edge.to;
}

function acquireKind(
  edge: GraphEdge,
): "craft" | "smelt" | "mine" | "loot" | "drop" | "trade" | null {
  if (edge.type === "produce" && edge.from.startsWith("action:craft:")) return "craft";
  if (edge.type === "produce" && edge.from.startsWith("action:smelt:")) return "smelt";
  if (edge.type === "produce" && edge.from.startsWith("action:silk_touch:")) return "mine";
  if (edge.type === "produce" && edge.from.startsWith("action:mine:")) return "mine";
  if (edge.type === "loot") return "loot";
  if (edge.type === "drop") return "drop";
  if (edge.type === "trade") return "trade";
  return null;
}

function grouped(edges: readonly GraphEdge[]): GraphEdge[][] {
  const groups = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    // The generated graph has no ingredient id. Quantity is the only stable
    // discriminator between two independent OR ingredient groups (barrel:
    // six planks and two slabs); edges sharing it are alternative choices for
    // one ingredient.
    const key = `${edge.type}:${edge.group}:${edge.quantity}`;
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

function stationName(id: string): string {
  return id.replace(/^station:/u, "").replace(/^minecraft:/u, "");
}
