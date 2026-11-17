# CraftMate Fabric body

This Fabric client mod connects Minecraft Java Edition 1.20.1 to CraftMate's
`/bridge` WebSocket protocol. It is the real game body: it runs game mutations
on the Minecraft client thread, reports progress and world evidence, and stops
local input when the connection or heartbeat fails.

Skill IDs, Java task classes and helper modules are mapped in
[Agent 编排与游戏身体映射](../../docs/reference/agent-body-mapping.md).
Wire frames and queue semantics are in [Bridge 设计](../../docs/reference/bridge.md).

## Build

Requires Java 17 or newer and network access to Fabric/Mojang Maven repositories.

```bash
cd mods/craftmate-body
./gradlew build
cp build/libs/craftmate-body-0.1.0.jar "$HOME/MC/.minecraft/mods/"
```

Install Fabric Loader 0.15.11 or newer and Fabric API 0.92.2+1.20.1 for
Minecraft 1.20.1 in HMCL. Remove any Fabric API jar built for another version,
then launch with the same game directory as the installed mod.

The bridge token is read from the operating-system account's
`~/.craftmate/bridge.token`; the orchestrator creates it with `0600`
permissions. HMCL passes `-Duser.home=<game dir>` to the game, so the mod
resolves `HOME` first instead of trusting that property. Set
`CRAFTMATE_BRIDGE_TOKEN_FILE` or `CRAFTMATE_HOME` to point both sides at
another location. The default endpoint is `ws://127.0.0.1:4321/bridge`.

The body is a client mod because camera, local player input, inventory
selection and visible client-side actions must run in the game client. A
command is acknowledged only after it has been accepted by the tick-thread
executor.

## Skills

The current body advertises 20 skills. The executable list and the Java task
for each skill are in
[Agent 编排与游戏身体映射](../../docs/reference/agent-body-mapping.md#4-技能到身体实现的映射).
`follow`, `flee` and `emote` exist only in the contract catalogue. Unknown
skills, invalid arguments or undeclared capabilities are rejected instead of
being treated as roadmap features.

`say` sends a Minecraft chat message. Live speech is produced by the Voice
service, not by this skill.

## Safety

- Network callbacks only enqueue work; Minecraft world changes happen on the
  client thread.
- Commands execute only while the most recent `welcome` / `ownership` state
  grants `agent` control.
- The local watchdog stops movement and mining after a missed heartbeat.
- `Reflexes` releases input for lava, falls, drowning, fire, low health and
  close threats before any task runs. It does not choose a long-term
  destination; the Agent owns that decision.
- `goto` uses a bounded A* over standable, non-liquid cells, follows the route
  with a turn limit, checks actual displacement for progress and replans a
  bounded number of times. Exploration may accept a proven partial route;
  ordinary movement must reach its target.
- Terrain handling includes one-block stair climbing, canopy descent, shaft
  escape and bridging across short gaps. Each bridge block must appear before
  the next one is submitted.
- Mining candidates must have a real exposed face and be within interaction
  reach. A block hidden behind terrain is rejected before destruction starts;
  the rendered camera direction is not the hit test.
- Unsupported or unsafe actions fail with a typed bridge error instead of
  pretending to succeed.
- Commands require a loaded level, local player, connection and game mode. An
  open pause or settings screen pauses tasks instead of being force-closed.

When no command is active and the agent owns control, `IdleWander` may look
around, take a short safe walk, or pick up a nearby drop. It never mines,
opens containers, or competes with a bridge command; an incoming task resets
it immediately.

## Observation

Each world snapshot includes:

- the full non-empty inventory (`hotbar` 0–8, `main` 9–35, `armor` 36–39,
  `offhand` 40) with optional durability;
- health, food, dimension, position, rotation, time and day;
- sleeping state, crafting-table facts, reachable blocks and nearby entities;
- visible ores, nearby block counts and bounded chunk-scan landmarks.

Session facts retain confirmed food, table, chest, bed and furnace state across
a long connection so consumed evidence does not make a milestone regress.
`ChunkIndex` scans loaded chunks with a small per-tick budget and only reports
blocks it actually observed; a landmark hint still needs navigation and
verification.

Camera rendering and player interaction are separate. `CameraController`,
`CameraSpring` and `CameraMixin` smooth the displayed camera; walking uses
`ViewSlew`. Block and entity interactions are submitted from coordinates,
distance and reachable faces, not from where the rendered camera points.

## Acceptance

Verification uses a real client, a real survival save and the normal launcher
flow. The mod has no automatic menu clicking, no acceptance environment
variable, and no property that creates or opens a world. Operators start the
game, load the save, and drive skills through the bridge.

Current evidence and remaining gaps are recorded in
[验证清单](../../docs/operations/verification.md).
