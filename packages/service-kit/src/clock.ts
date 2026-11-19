export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function businessDate(date: Date, offsetMinutes = 330): string {
  return new Date(date.getTime() + offsetMinutes * 60000).toISOString().slice(0, 10);
}

export function businessDayStartIso(date: Date, offsetMinutes = 330): string {
  const day = businessDate(date, offsetMinutes);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - offsetMinutes * 60000).toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
