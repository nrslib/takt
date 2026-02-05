/**
 * Detect judgment result from conductor's response.
 */
export interface JudgmentResult {
  success: boolean;
  tag?: string; // e.g., "[ARCH-REVIEW:1]"
  reason?: string;
}

export class JudgmentDetector {
  private static readonly TAG_PATTERN = /\[([A-Z_-]+):(\d+)\]/;
  private static readonly CANNOT_JUDGE_PATTERNS = [
    /判断できない/i,
    /cannot\s+determine/i,
    /unable\s+to\s+judge/i,
    /insufficient\s+information/i,
  ];

  static detect(response: string): JudgmentResult {
    // 1. タグ検出
    const tagMatch = response.match(this.TAG_PATTERN);
    if (tagMatch) {
      return {
        success: true,
        tag: tagMatch[0], // e.g., "[ARCH-REVIEW:1]"
      };
    }

    // 2. 「判断できない」検出
    for (const pattern of this.CANNOT_JUDGE_PATTERNS) {
      if (pattern.test(response)) {
        return {
          success: false,
          reason: 'Conductor explicitly stated it cannot judge',
        };
      }
    }

    // 3. タグも「判断できない」もない → 失敗
    return {
      success: false,
      reason: 'No tag found and no explicit "cannot judge" statement',
    };
  }
}
