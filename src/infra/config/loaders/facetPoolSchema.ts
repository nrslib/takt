import { z } from 'zod/v4';

export const ExternalFacetPoolFileRawSchema = z.object({
  policies: z.record(z.string(), z.string()).optional(),
  knowledge: z.record(z.string(), z.string()).optional(),
  candidates: z.array(
    z.object({
      id: z.string().trim().min(1),
      description: z.string().trim().min(1),
      policy: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
      knowledge: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    }).strict(),
  ).min(1),
  uses: z.never().optional(),
  params: z.never().optional(),
}).strict().superRefine((pool, ctx) => {
  const ids = new Set<string>();
  for (const [index, candidate] of pool.candidates.entries()) {
    if (candidate.policy === undefined && candidate.knowledge === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates', index, 'id'],
        message: 'Facet pool candidate requires at least one of "policy" or "knowledge"',
      });
    }
    if (ids.has(candidate.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidates', index, 'id'],
        message: `Facet pool candidate id "${candidate.id}" is duplicate within this pool`,
      });
    }
    ids.add(candidate.id);
  }
});

export type ExternalFacetPoolFileRaw = z.output<typeof ExternalFacetPoolFileRawSchema>;