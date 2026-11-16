const windowSeconds = 60;
const intervals = 4;

function niceStep(minimum: number) {
  const magnitude = 10 ** Math.floor(Math.log10(minimum));
  return magnitude * ([1, 2, 2.5, 5, 10].find(step => step * magnitude >= minimum) ?? 10);
}

export function timeAxis(elapsed: number) {
  if (elapsed >= windowSeconds) {
    return { start: elapsed - windowSeconds, end: elapsed, step: windowSeconds / intervals };
  }
  const step = Math.min(windowSeconds / intervals, niceStep(Math.max(elapsed, 0.1) / intervals));
  return { start: 0, end: step * intervals, step };
}

export function speedAxis(peak: number) {
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(Math.max(1, peak)) / Math.log(1024))));
  const divisor = 1024 ** index;
  const step = niceStep((peak > 0 ? peak / divisor : 1) / intervals);
  return { maximum: step * intervals * divisor, step, unit: units[index] };
}
