import { restore } from './storage.mjs';
import { dispatch } from './dispatch.mjs';
export const work = async (queue, fs) => dispatch(await restore(queue), fs);
