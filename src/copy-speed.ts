const bucketSeconds = 0.25;
// Progress reports arrive independently for each target. Leave the newest samples
// out of the history while they can still receive data from another target.
export function stableSpeedEnd(elapsed: number, running: boolean, targetTimes: number[]) {
  if (!running) return elapsed;
  const watermark = Math.min(elapsed - 0.5, ...targetTimes);
  return Math.floor(Math.max(0, watermark) / bucketSeconds) * bucketSeconds;
}

export type SpeedBucket = { bytes: number; seconds: number };
type SpeedHistory = ReadonlyMap<number, SpeedBucket>;

export function addSpeedSample(history: SpeedHistory, end: number, bytes: number, rate: number): Map<number, SpeedBucket> {
  const cutoff = Math.floor((end - 62) / bucketSeconds);
  const next = new Map([...history].filter(([index]) => index >= cutoff));
  if (bytes <= 0 || !Number.isFinite(rate) || rate <= 0) return next;
  const seconds = bytes / rate;
  const start = Math.max(0, end - seconds);
  if (start >= end) {
    const index = Math.floor(end / bucketSeconds);
    const previous = next.get(index) ?? { bytes: 0, seconds: 0 };
    next.set(index, { bytes: previous.bytes + bytes, seconds: previous.seconds + seconds });
    return next;
  }
  for (let index = Math.max(cutoff, Math.floor(start / bucketSeconds)); index * bucketSeconds < end; index++) {
    const active = Math.min(end, (index + 1) * bucketSeconds) - Math.max(start, index * bucketSeconds);
    const previous = next.get(index) ?? { bytes: 0, seconds: 0 };
    next.set(index, { bytes: previous.bytes + rate * active, seconds: previous.seconds + active });
  }
  return next;
}

export function speedIntervals(histories: (SpeedHistory | undefined)[], start: number, end: number) {
  const intervals = [];
  for (let index = Math.floor(start / bucketSeconds); index * bucketSeconds < end; index++) {
    let speed = 0;
    for (const history of histories) {
      const sample = history?.get(index);
      if (sample) speed += sample.bytes / sample.seconds;
    }
    intervals.push({
      start: Math.max(start, index * bucketSeconds),
      end: Math.min(end, (index + 1) * bucketSeconds),
      speed,
    });
  }
  return intervals;
}

export function continuousSpeed(intervals: ReturnType<typeof speedIntervals>) {
  const firstMeasurement = intervals.findIndex(interval => interval.speed > 0);
  return firstMeasurement === -1 ? [] : intervals.slice(firstMeasurement);
}
