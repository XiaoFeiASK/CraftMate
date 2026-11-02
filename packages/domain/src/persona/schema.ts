import { z } from "zod";

const weightsSchema = z.object({
  obedience: z.number().min(0).max(1),
  risk: z.number().min(0).max(1),
  sass: z.number().min(0).max(1),
  patience: z.number().min(0).max(1),
  gluttony: z.number().min(0).max(1),
});

const styleSchema = z.object({
  tone: z.string().min(1),
  sentenceLength: z.enum(["short", "medium", "long"]),
  verbalTics: z.array(z.string()).max(8),
  quirks: z.array(z.string()).max(8),
});

const voiceSchema = z.object({
  provider: z.string().min(1),
  voiceId: z.string().min(1),
  speed: z.number().min(0.5).max(2),
});

export const personaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  identity: z.string().min(1),
  values: z.array(z.string()).max(16),
  style: styleSchema,
  boundaries: z.array(z.string()).max(16),
  weights: weightsSchema,
  voice: voiceSchema,
});

export type Persona = z.infer<typeof personaSchema>;
export type PersonaWeights = Persona["weights"];
