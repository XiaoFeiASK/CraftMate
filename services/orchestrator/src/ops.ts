import type { OpsRequest, OpsSnapshot } from "@craftmate/contracts";
import type { Show } from "@craftmate/agent/application";
import type { CostStore, MemoryStore, PersonaVersionStore, ReplayStore } from "@craftmate/storage";
import type { OpsHooks } from "./transport/control-server.ts";

export interface OpsOptions {
  readonly show: Show;
  readonly memory: MemoryStore;
  readonly personas: PersonaVersionStore;
  readonly replay: ReplayStore;
  readonly costs: CostStore;
  readonly personaKey: string;
  readonly onSettings: (next: unknown) => unknown | null;
  readonly hourlyLimit?: number;
}

/**
 * Operator-facing data. Persona drafts are validated by the settings schema
 * before they become a version, so a bad edit cannot poison the active row.
 */
export function createOps(options: OpsOptions): OpsHooks {
  const personaKey = options.personaKey;

  const snapshot = (): OpsSnapshot => {
    const settings = options.show.currentSettings();
    return {
      memories: [...options.memory.list()],
      candidates: [...options.memory.pendingCandidates()],
      personaVersions: options.personas.history(personaKey).map((version) => ({
        id: version.id,
        personaId: version.personaId,
        revision: version.revision,
        state: version.state,
        createdAt: version.createdAt,
        content: version.content,
      })),
      budget: options.costs.budget({
        hourlyLimit: options.hourlyLimit ?? 0,
        keyLimit: 0,
        provider: settings.persona.voice.provider,
      }),
    };
  };

  return {
    snapshot,
    apply: (request: OpsRequest) => {
      switch (request.kind) {
        case "refresh":
          return;
        case "approveMemory":
          options.memory.approveCandidate(request.candidateId);
          return;
        case "rejectMemory":
          options.memory.rejectCandidate(request.candidateId, request.reason);
          return;
        case "forgetMemory":
          options.memory.forget(request.memoryId);
          return;
        case "draftPersona": {
          const current = options.show.currentSettings();
          const next = { ...current, persona: request.persona };
          const applied = options.onSettings(next);
          if (applied === null) throw new Error("人格内容未通过校验，未生效");
          options.personas.publish(personaKey, request.persona as unknown as Record<string, unknown>);
          return;
        }
        case "activatePersona": {
          options.personas.activate(personaKey, request.versionId);
          const version = options.personas
            .history(personaKey)
            .find((item) => item.id === request.versionId);
          if (!version) throw new Error(`人格版本 ${request.versionId} 不存在`);
          const current = options.show.currentSettings();
          const applied = options.onSettings({
            ...current,
            persona: { ...current.persona, ...version.content },
          });
          if (applied === null) throw new Error("人格版本内容不合法，未生效");
          return;
        }
        default:
          return;
      }
    },
    timeline: (traceId) => [...options.replay.timeline(traceId)],
  };
}
