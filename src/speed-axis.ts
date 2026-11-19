const intervals = 4;

function niceStep(minimum: number) {
  const magnitude = 10 ** Math.floor(Math.log10(minimum));
  return magnitude * ([1, 2, 2.5, 5, 10].find(step => step * magnitude >= minimum) ?? 10);
}

function speedAxis(peak: number) {
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(Math.max(1, peak)) / Math.log(1024))));
  const divisor = 1024 ** index;
  const step = niceStep((peak > 0 ? peak / divisor : 1) / intervals);
  return { maximum: step * intervals * divisor, step, unit: units[index] };
}

export function transferSpeedAxis(
  points: { end: number; speed: number }[], end: number, liveRate?: number,
) {
  const peak = Math.max(0, ...points.map(point => point.speed));
  if (liveRate === undefined) return speedAxis(peak);
  const recent = points.filter(point => point.end > end - 8 && point.speed > 0)
    .map(point => point.speed).sort((a, b) => a - b);
  const reference = recent.length ? recent[Math.floor((recent.length - 1) * 0.9)] : liveRate;
  return speedAxis(reference * 1.15 || peak);
}
