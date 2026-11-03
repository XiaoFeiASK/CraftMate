import type { SkillName } from "@craftmate/contracts";

/**
 * MCPFabric is an adapter, not the contract. These mappings are intentionally
 * partial: anything marked `weak` must be composed by the body or rejected,
 * never passed through as if it were a validated skill.
 */
export type AdapterStrength = "strong" | "composed" | "weak" | "missing";

export interface McpFabricMapping {
  readonly skill: SkillName;
  readonly strength: AdapterStrength;
  readonly tools: readonly string[];
  readonly note: string;
}

export const MCPFABRIC_MAPPINGS: readonly McpFabricMapping[] = [
  { skill: "goto", strength: "strong", tools: ["navigate_to"], note: "A* pathfinding" },
  { skill: "look_at", strength: "strong", tools: ["look_at"], note: "" },
  { skill: "place_block", strength: "strong", tools: ["place_block"], note: "" },
  { skill: "attack", strength: "strong", tools: ["attack_entity"], note: "" },
  { skill: "say", strength: "strong", tools: ["send_chat"], note: "must pass output review" },
  {
    skill: "mine_block",
    strength: "composed",
    tools: ["find_blocks", "navigate_to", "break_block"],
    note: "no vein semantics; outer loop required",
  },
  {
    skill: "craft",
    strength: "composed",
    tools: ["plan_craft", "craft_item"],
    note: "depends on agent runtime",
  },
  { skill: "eat", strength: "composed", tools: ["use_item"], note: "" },
  {
    skill: "deposit",
    strength: "composed",
    tools: ["open_container", "container_transfer"],
    note: "",
  },
  { skill: "equip", strength: "weak", tools: ["select_hotbar_slot"], note: "hotbar only" },
  { skill: "sleep", strength: "weak", tools: ["use_entity"], note: "no dedicated tool" },
  { skill: "follow", strength: "weak", tools: ["navigate_to"], note: "outer loop" },
  { skill: "flee", strength: "weak", tools: [], note: "direction policy missing" },
  { skill: "emote", strength: "missing", tools: [], note: "no animation tool" },
  { skill: "wait", strength: "strong", tools: [], note: "local timer, no game call" },
];

export interface McpFabricSafetyOptions {
  /** Operator-level tools must be disabled at the upstream server. */
  readonly enableCommands: false;
  readonly enableWorldWrite: false;
  readonly enableUiControl: false;
}

export interface McpFabricHandshake {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly safety: McpFabricSafetyOptions;
}

/**
 * The adapter refuses to expose a callable surface until the dangerous MCP
 * tool groups are demonstrably off. This is a declaration, not a probe: the
 * real probe must be added once mcpfabric is installed on the machine.
 */
export function assertSafeMcpFabricHandshake(handshake: McpFabricHandshake): void {
  if (!handshake.baseUrl.startsWith("http://127.0.0.1:")) {
    throw new Error("mcpfabric must bind to loopback");
  }
  if (handshake.safety.enableCommands || handshake.safety.enableWorldWrite) {
    throw new Error("mcpfabric dangerous tools must stay disabled");
  }
}

export function availableSkills(mappings: readonly McpFabricMapping[] = MCPFABRIC_MAPPINGS): SkillName[] {
  return mappings
    .filter((mapping) => mapping.strength === "strong" || mapping.strength === "composed")
    .map((mapping) => mapping.skill);
}
