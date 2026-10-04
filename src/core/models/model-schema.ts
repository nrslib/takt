import { z } from 'zod/v4';

export const ConfiguredModelSchema = z.string().trim().min(1, 'model must not be empty');
