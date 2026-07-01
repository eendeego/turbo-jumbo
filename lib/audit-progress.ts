import type {AuditProgressEvent} from '@/lib/audit';
import {rateLimited} from '@/lib/rate-limit';

/**
 * An `onHashProgress` adapter for one file that forwards hashing progress as
 * `AuditProgressEvent`s, thinned to one per `intervalMs` — except the final
 * event (hashedBytes reaching totalBytes), which always fires so consumers
 * see the hash complete. `clock` is injectable for tests.
 */
export function hashProgressEmitter(
  file: string,
  emit: (event: AuditProgressEvent) => void,
  intervalMs: number,
  clock?: () => number,
): (hashedBytes: number, totalBytes: number) => void {
  const send = rateLimited(intervalMs, emit, clock);
  return (hashedBytes, totalBytes) => {
    if (hashedBytes >= totalBytes) emit({file, hashedBytes, totalBytes});
    else send({file, hashedBytes, totalBytes});
  };
}
