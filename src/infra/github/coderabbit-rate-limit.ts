export interface CodeRabbitRateLimit {
  readonly retryAt: number | undefined;
  readonly createdAt: number | undefined;
  readonly isCommandReply: boolean;
}

export function parseCodeRabbitRateLimit(body: string, createdAt: string): CodeRabbitRateLimit | undefined {
  const tagged = /<!--[^>]*\brate limited by coderabbit\.ai\b[^>]*-->/iu.test(body);
  const commandReply = /Action not completed/iu.test(body) && /Review rate limited\./iu.test(body);
  if (!tagged && !commandReply) return undefined;

  const minutes = /Next included review available in (\d+) minutes?\./iu.exec(body);
  const postedAt = Date.parse(createdAt);
  const retryAt = minutes === null ? NaN : postedAt + Number(minutes[1]) * 60_000;
  return {
    retryAt: Number.isFinite(retryAt) ? retryAt : undefined,
    createdAt: Number.isFinite(postedAt) ? postedAt : undefined,
    isCommandReply: commandReply,
  };
}
