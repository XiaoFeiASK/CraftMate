# CraftMate Fabric body

This Fabric client mod connects Minecraft Java Edition 1.20.1 to CraftMate's
`/bridge` WebSocket protocol. It is the real game body used by the orchestrator:
it runs game mutations on the Minecraft client thread, reports progress and
results, and stops local input when the connection or heartbeat fails.

## Build

Requires Java 17 or newer and network access to Fabric/Mojang Maven repositories.

```bash
cd mods/craftmate-body
./gradlew build
cp build/libs/craftmate-body-0.1.0.jar "$HOME/MC/.minecraft/mods/"
```

Install Fabric Loader 0.15.11 or newer and Fabric API 0.92.2+1.20.1 for Minecraft 1.20.1
in HMCL. Remove any Fabric API jar built for another Minecraft version, then launch with the
same game directory as the installed mod. The bridge token is read from the
operating-system account's `~/.craftmate/bridge.token`; the orchestrator creates
it with `0600` permissions. HMCL passes `-Duser.home=<game dir>` to the game, so
the mod resolves `HOME` first instead of trusting that property. Set
`CRAFTMATE_BRIDGE_TOKEN_FILE` or `CRAFTMATE_HOME` to point both sides at another
location. The default endpoint is `ws://127.0.0.1:4321/bridge`.

The body is a client mod because camera, local player input, inventory selection,
and visible client-side actions must run in the game client. A command sent to
this mod is acknowledged only after it has been accepted by the tick-thread
executor.

## Safety

- Network callbacks only enqueue work; Minecraft world changes happen on the client
  thread.
- Commands execute only while the server's most recent `welcome`/`ownership`
  state grants `agent` control.
- The local watchdog stops movement and mining after a missed heartbeat.
- `goto` uses a bounded A* over standable, non-liquid cells (4000 nodes). It
  follows the returned waypoints with a `12°/tick` turn limit, checks actual
  displacement for progress, and replans at most three times after three
  seconds without progress. Exploration may pass up to eight candidate
  headings and accept a proven partial route as a new observation area;
  ordinary movement still must reach its exact target.
- Terrain handling includes one-block stair climbing, canopy descent, shaft
  escape, and verified bridging across short gaps. Each bridge block must
  appear in the world before the next one is submitted.
- Unsupported or unsafe actions fail with a typed bridge error instead of
  pretending to succeed.
- Commands require a loaded client level, local player, connection, and game
  mode. An open pause or settings screen does not by itself make a loaded
  world unusable.
- Mining candidates must pass a current line-of-sight raycast. A nearby block
  hidden behind terrain is rejected before destruction starts.
- `chop_tree` reuses the same destroy state machine with `BlockTags.LOGS` as
  the target set. `count` is the number of log blocks, not a whole-tree BFS.
  If the selected log is unreachable, it re-selects a visible log after 10
  seconds and then fails with `E_TIMEOUT` instead of walking forever.
- `sleep` walks to a bed within 16 blocks, right-clicks it, and only completes
  when `isSleeping()` is observed and the world day counter advanced. Daytime,
  no bed, an occupied bed, an exploding-bed dimension, a conflicting screen
  and a rejected interaction each return `E_PRECONDITION`; a bed that never
  advances the day returns `E_TIMEOUT`. Cancel, takeover or disconnect sends
  the normal stop-sleeping command instead of leaving the body in bed.
- `place_block` accepts a bed item and checks both cells before submitting,
  trying each horizontal heading so the second half has room.
- `pillar_up` jumps, looks down, and places one confirmed block under the
  body at a time, up to 16 blocks.
- `attack` approaches distant targets before swinging, verifies damage or
  death on the same entity, waits for attack charge, and can collect drops.

The current body advertises 16 skills: `goto`, `look_at`, `mine_block`,
`chop_tree`, `collect_items`, `craft`, `deposit`, `say`, `wait`, `attack`,
`equip`, `eat`, `use_block`, `place_block`, `pillar_up`, and `sleep`.

Camera rendering and player interaction are separate. `CameraController` and
`CameraMixin` smooth the displayed camera with clamped angular speed; aiming
still uses the real player rotation and line-of-sight raycast. Walking uses
`ViewSlew`, so the body never snaps its heading between waypoints.

When no command is active and the agent owns control, `IdleWander` may look
around, take a short safe walk, or pick up a nearby drop. It never mines,
opens containers, or competes with a bridge command; an incoming task resets
it immediately.

## Observation

Each heartbeat world snapshot includes the full non-empty `inventory`
(`hotbar` 0–8, `main` 9–35, `armor` 36–39, `offhand` 40) with optional
durability, plus `timeOfDay` (0–23999), `day`, `sleeping`, crafting-table
facts, reachable block, and nearby entity coordinates. Session facts retain
confirmed food and table state across a long connection so consumed evidence
does not make a milestone regress. The older `hotbar` array stays for
compatibility, but it is no longer the only view of the backpack.

## Acceptance

Verification uses a real client, a real survival save and the normal launcher
flow. The mod has no automatic menu clicking, no acceptance environment
variable, and no property that creates or opens a world. Operators start the
game, load the save, and drive skills through the bridge.
