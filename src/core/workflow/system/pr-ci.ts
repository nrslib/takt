import { z } from 'zod/v4';

export const PrCiFailureSchema = z.object({
  number: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  complete: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    run: z.object({
      id: z.number().int().positive(), attempt: z.number().int().positive(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/i), url: z.string().url(),
    }),
    jobs: z.array(z.object({
      id: z.number().int().positive(), name: z.string(), url: z.string().url(), log: z.string().optional(),
    })),
  })),
  unavailable: z.array(z.object({ name: z.string(), url: z.string().nullable().optional(), reason: z.string() })),
});

export const PrCiRerunSchema = z.object({
  number: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  runs: z.array(z.object({
    id: z.number().int().positive(), attempt: z.number().int().positive(), url: z.string().url().optional(),
  })).min(1),
});

export type PrCiFailure = z.infer<typeof PrCiFailureSchema>;
export type PrCiRerun = z.infer<typeof PrCiRerunSchema>;

export interface PrCiCheck {
  kind: 'CheckRun' | 'StatusContext';
  name: string;
  url: string | null;
  finished: boolean;
  passed: boolean;
}

export interface PrCiRerunResult extends PrCiRerun {
  success: boolean;
  failed: boolean;
  headChanged?: boolean;
  error?: string;
}
