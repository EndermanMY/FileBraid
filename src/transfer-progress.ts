type WorkRow = { bytes: number; existing: boolean; verified_by: readonly string[] };
type WorkStatus = 'verified' | 'reused' | 'copied' | 'failed' | 'cancelled';
type WorkEvent = { phase: 'source' | 'copy' | 'flush' | 'await_verify' | 'verify'; bytes: number };

export function fileWork(row: WorkRow, verifyOnly: boolean, status: WorkStatus | undefined,
  current: WorkEvent | undefined, staged: boolean) {
  // A zero-byte file still has a write and/or verification step.
  const base = row.bytes || 1;
  const total = verifyOnly || row.existing || row.verified_by.length ? 2 * base : base;
  if (status) return { total, done: status === 'failed' || status === 'cancelled' ? 0 : total };
  const partial = current ? Math.max(0, Math.min(current.bytes, row.bytes)) : 0;
  const done = current?.phase === 'verify' ? base + partial
    : staged || current?.phase === 'flush' || current?.phase === 'await_verify' ? base
      : partial;
  return { total, done: Math.min(total, done) };
}
