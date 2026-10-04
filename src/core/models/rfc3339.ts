const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt]([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(?:\.(\d{1,3}))?([Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const RFC3339_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEAP_SECOND_DATES = [
  '1972-06-30', '1972-12-31', '1973-12-31', '1974-12-31', '1975-12-31',
  '1976-12-31', '1977-12-31', '1978-12-31', '1979-12-31', '1981-06-30',
  '1982-06-30', '1983-06-30', '1985-06-30', '1987-12-31', '1989-12-31',
  '1990-12-31', '1992-06-30', '1993-06-30', '1994-06-30', '1995-12-31',
  '1997-06-30', '1998-12-31', '2005-12-31', '2008-12-31', '2012-06-30',
  '2015-06-30', '2016-12-31',
];
const LEAP_SECOND_DATE_SET = new Set(LEAP_SECOND_DATES);
const LEAP_SECOND_BOUNDARIES = LEAP_SECOND_DATES.map(
  (date) => Date.parse(`${date}T23:59:59.000Z`) + 1_000,
);

interface ParsedRfc3339Timestamp {
  epochMilliseconds: number;
  timelineMilliseconds: number;
  normalized: string;
}

function invalidTimestamp(timestamp: string): Error {
  return new Error(`Expected a valid RFC 3339 timestamp, received "${timestamp}"`);
}

function formatNormalizedTimestamp(epochMilliseconds: number, timestamp: string): string {
  const normalized = new Date(epochMilliseconds).toISOString();
  if (!RFC3339_UTC_TIMESTAMP.test(normalized)) {
    throw invalidTimestamp(timestamp);
  }
  return normalized;
}

function formatNormalizedLeapSecond(precedingSecondEpochMilliseconds: number, timestamp: string): string {
  const precedingSecond = new Date(precedingSecondEpochMilliseconds);
  const precedingSecondIso = precedingSecond.toISOString();
  const leapDate = precedingSecondIso.slice(0, 10);
  if (
    !LEAP_SECOND_DATE_SET.has(leapDate)
    || precedingSecond.getUTCHours() !== 23
    || precedingSecond.getUTCMinutes() !== 59
    || precedingSecond.getUTCSeconds() !== 59
  ) {
    throw invalidTimestamp(timestamp);
  }
  return `${leapDate}T23:59:60.${precedingSecondIso.slice(20, 23)}Z`;
}

function timelineMilliseconds(epochMilliseconds: number, leapSecondBoundary: number | undefined): number {
  const elapsedLeapSeconds = LEAP_SECOND_BOUNDARIES.filter((boundary) => (
    leapSecondBoundary === undefined ? boundary <= epochMilliseconds : boundary < leapSecondBoundary
  )).length;
  return epochMilliseconds + elapsedLeapSeconds * 1_000;
}

function parseTimestamp(timestamp: string): ParsedRfc3339Timestamp {
  const match = RFC3339_TIMESTAMP.exec(timestamp);
  if (match === null) {
    throw new Error(`Expected an RFC 3339 timestamp, received "${timestamp}"`);
  }

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const normalizedSecond = second === 60 ? 59 : second;
  const civilTime = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${String(normalizedSecond).padStart(2, '0')}Z`);
  if (
    Number.isNaN(civilTime.getTime())
    || civilTime.getUTCFullYear() !== year
    || civilTime.getUTCMonth() + 1 !== month
    || civilTime.getUTCDate() !== day
    || civilTime.getUTCHours() !== hour
    || civilTime.getUTCMinutes() !== minute
    || civilTime.getUTCSeconds() !== normalizedSecond
  ) {
    throw invalidTimestamp(timestamp);
  }

  const fraction = match[7] === undefined ? '' : `.${match[7]}`;
  const timezone = match[8]!.toUpperCase();
  const normalizedInput = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${String(normalizedSecond).padStart(2, '0')}${fraction}${timezone}`;
  const precedingSecondEpochMilliseconds = Date.parse(normalizedInput);
  if (Number.isNaN(precedingSecondEpochMilliseconds)) {
    throw invalidTimestamp(timestamp);
  }

  if (second === 60) {
    const epochMilliseconds = precedingSecondEpochMilliseconds + 1_000;
    return {
      epochMilliseconds,
      timelineMilliseconds: timelineMilliseconds(
        epochMilliseconds,
        Math.floor(epochMilliseconds / 1_000) * 1_000,
      ),
      normalized: formatNormalizedLeapSecond(precedingSecondEpochMilliseconds, timestamp),
    };
  }

  const epochMilliseconds = precedingSecondEpochMilliseconds;
  if (Number.isNaN(epochMilliseconds)) {
    throw invalidTimestamp(timestamp);
  }
  return {
    epochMilliseconds,
    timelineMilliseconds: timelineMilliseconds(epochMilliseconds, undefined),
    normalized: formatNormalizedTimestamp(epochMilliseconds, timestamp),
  };
}

/** RFC 3339 のうるう秒を含む実経過時間計算用の単調タイムライン値。 */
export function rfc3339TimelineMilliseconds(timestamp: string): number {
  return parseTimestamp(timestamp).timelineMilliseconds;
}

export function normalizeRfc3339Timestamp(timestamp: string): string {
  return parseTimestamp(timestamp).normalized;
}

export function compareRfc3339Timestamps(left: string, right: string): number {
  const normalizedLeft = parseTimestamp(left).normalized;
  const normalizedRight = parseTimestamp(right).normalized;
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}
