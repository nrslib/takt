export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface InquiryPosition {
  question: { id: string; createdAt?: string };
  repositoryDirectory?: string;
  goalId: string | null;
}

export function compareInquiries(left: InquiryPosition, right: InquiryPosition): number {
  const leftTime = left.question.createdAt === undefined ? Infinity : Date.parse(left.question.createdAt);
  const rightTime = right.question.createdAt === undefined ? Infinity : Date.parse(right.question.createdAt);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return compareText(left.repositoryDirectory ?? '', right.repositoryDirectory ?? '')
    || compareText(left.goalId ?? '', right.goalId ?? '')
    || compareText(left.question.id, right.question.id);
}

