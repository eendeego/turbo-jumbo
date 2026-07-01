import type {AuditProgressEvent, AuditResult, AuditStatus} from '@/lib/audit';

// Ordering for aggregating a row's verdicts: the row shows its worst one.
const AUDIT_SEVERITY: Record<AuditStatus, number> = {
  error: 6,
  'checksum-mismatch': 5,
  incomplete: 4,
  duplicate: 3,
  misplaced: 2,
  unverifiable: 1,
  pass: 0,
};

export type RowAudit =
  | {kind: 'pending'; percent?: number}
  | {kind: 'result'; status: AuditStatus; message?: string; cached: boolean}
  | null;

/**
 * The audit state a table row displays for its paths: null when none were
 * audited, the worst verdict when all results are in, otherwise pending — with
 * the row's SHA256 hashing percent when any of its files reported progress
 * (summed across in-flight paths, so multi-shard rows show one number).
 */
export function rowAudit(
  paths: string[],
  auditedPaths: Set<string>,
  auditResults: Map<string, AuditResult>,
  auditing: boolean,
  auditProgress?: Map<string, AuditProgressEvent>,
): RowAudit {
  const relevant = paths.filter((p) => auditedPaths.has(p));
  if (relevant.length === 0) return null;
  const results = relevant
    .map((p) => auditResults.get(p))
    .filter((r): r is AuditResult => r != null);
  if (results.length === 0 || (results.length < relevant.length && auditing)) {
    let hashed = 0;
    let total = 0;
    for (const p of relevant) {
      const prog = auditProgress?.get(p);
      if (prog) {
        hashed += prog.hashedBytes;
        total += prog.totalBytes;
      }
    }
    return total > 0
      ? {kind: 'pending', percent: Math.floor((hashed / total) * 100)}
      : {kind: 'pending'};
  }
  const worst = results.reduce((a, b) =>
    AUDIT_SEVERITY[b.status] > AUDIT_SEVERITY[a.status] ? b : a,
  );
  return {
    kind: 'result',
    status: worst.status,
    message: worst.message,
    cached: !!worst.cached,
  };
}
