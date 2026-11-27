import { enqueue } from './intake.mjs';
import { work } from './worker.mjs';
export async function serve(request, queue, fs) {
  await enqueue(await request.json(), queue);
  return work(queue, fs);
}
