import { readDocument } from './reader.mjs';
export const dispatch = (job, fs) => readDocument({ path: job.path }, fs);
