export const restore = async queue => JSON.parse(await queue.take());
