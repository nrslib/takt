export const CODEC_CONTRACT = Object.freeze([
  Object.freeze({ name: 'json-v1', contentKind: 'json', digestAlgorithm: 'sha256' }),
  Object.freeze({ name: 'text-v1', contentKind: 'text', digestAlgorithm: 'sha256' }),
] as const);

export function assertCodecContent(codecName: string, encoded: string): void {
  const codec = CODEC_CONTRACT.find((candidate) => candidate.name === codecName);
  if (codec === undefined) {
    throw new Error(`Unknown run storage codec "${codecName}"`);
  }
  if (codec.contentKind === 'json') {
    try {
      JSON.parse(encoded);
    } catch {
      throw new Error(`Codec "${codecName}" requires valid JSON content`);
    }
  }
}
