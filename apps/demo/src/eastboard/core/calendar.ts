import type { OptionSession } from "./underlyings";

export type IsoDate = `${number}-${number}-${number}`;

const CN_2026_HOLIDAYS = new Set([
  "2026-01-01",
  "2026-01-02",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-23",
  "2026-04-06",
  "2026-05-01",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-09-25",
  "2026-10-01",
  "2026-10-02",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
]);

const HK_2026_HOLIDAYS = new Set([
  "2026-01-01",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-04-03",
  "2026-04-06",
  "2026-04-07",
  "2026-05-01",
  "2026-05-25",
  "2026-06-19",
  "2026-07-01",
  "2026-09-26",
  "2026-10-01",
  "2026-10-19",
  "2026-12-25",
  "2026-12-28",
]);

export const HK_2026_HALF_DAYS = new Set([
  "2026-02-16",
  "2026-12-24",
  "2026-12-31",
]);

function asUtcDate(date: IsoDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10) as IsoDate;
}

export function isTradingDate(session: OptionSession, date: IsoDate): boolean {
  const day = asUtcDate(date).getUTCDay();
  if (day === 0 || day === 6) return false;
  return !(session === "cn" ? CN_2026_HOLIDAYS : HK_2026_HOLIDAYS).has(date);
}

export function nextTradingDates(
  session: OptionSession,
  from: IsoDate,
  count: number,
): IsoDate[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Trading-date count must be a non-negative integer: ${count}`);
  }
  const cursor = asUtcDate(from);
  const dates: IsoDate[] = [];
  while (dates.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const candidate = toIsoDate(cursor);
    if (isTradingDate(session, candidate)) dates.push(candidate);
  }
  return dates;
}

export function tradingDatesOnOrAfter(
  session: OptionSession,
  from: IsoDate,
  count: number,
): IsoDate[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Trading-date count must be a non-negative integer: ${count}`);
  }
  const cursor = asUtcDate(from);
  const dates: IsoDate[] = [];
  while (dates.length < count) {
    const candidate = toIsoDate(cursor);
    if (isTradingDate(session, candidate)) dates.push(candidate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function getSessionClose(
  session: OptionSession,
  date: IsoDate,
): { closeTs: number; label: string; isHalfDay: boolean } {
  if (!isTradingDate(session, date)) {
    throw new Error(`${date} is not a ${session.toUpperCase()} trading date`);
  }
  const isHalfDay = session === "hk" && HK_2026_HALF_DAYS.has(date);
  const time = session === "cn" ? "07:00:00Z" : isHalfDay ? "04:10:00Z" : "08:10:00Z";
  const closeTs = Math.floor(Date.parse(`${date}T${time}`) / 1_000);
  const label = session === "cn" ? "15:00 CST" : isHalfDay ? "12:10 HKT" : "16:10 HKT";
  return { closeTs, label, isHalfDay };
}

/**
 * Trading dates spanning a window that reaches BACK as well as forward.
 *
 * A market settles only after its close date has passed, so a forward-only
 * board drops every settled market before its holders can claim. Keeping a
 * few closed sessions visible is what makes settled markets reachable.
 */
export function tradingDatesAround(
  session: OptionSession,
  from: IsoDate,
  past: number,
  future: number,
): IsoDate[] {
  if (!Number.isInteger(past) || past < 0) {
    throw new Error(`Trading-date history count must be a non-negative integer: ${past}`);
  }
  const history: IsoDate[] = [];
  const cursor = asUtcDate(from);
  while (history.length < past) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const candidate = toIsoDate(cursor);
    if (isTradingDate(session, candidate)) history.unshift(candidate);
  }
  return [...history, ...tradingDatesOnOrAfter(session, from, future)];
}
