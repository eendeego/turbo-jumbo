import {test, expect} from 'bun:test';
import {rowAudit} from '@/lib/row-audit';
import type {AuditProgressEvent, AuditResult} from '@/lib/audit';

const result = (file: string, status: AuditResult['status']): AuditResult => ({
  file,
  status,
});

test('null when none of the row paths were audited', () => {
  expect(rowAudit(['a.gguf'], new Set(), new Map(), false)).toBeNull();
});

test('aggregates results to the worst severity', () => {
  const audit = rowAudit(
    ['a.gguf', 'b.gguf'],
    new Set(['a.gguf', 'b.gguf']),
    new Map([
      ['a.gguf', result('a.gguf', 'pass')],
      ['b.gguf', result('b.gguf', 'checksum-mismatch')],
    ]),
    false,
  );
  expect(audit).toEqual({
    kind: 'result',
    status: 'checksum-mismatch',
    message: undefined,
    cached: false,
  });
});

test('pending without percent while no hashing progress is known', () => {
  expect(rowAudit(['a.gguf'], new Set(['a.gguf']), new Map(), true)).toEqual({
    kind: 'pending',
  });
});

test('pending carries the hashing percent when progress is known', () => {
  const progress = new Map<string, AuditProgressEvent>([
    ['a.gguf', {file: 'a.gguf', hashedBytes: 42, totalBytes: 100}],
  ]);
  expect(
    rowAudit(['a.gguf'], new Set(['a.gguf']), new Map(), true, progress),
  ).toEqual({kind: 'pending', percent: 42});
});

test('percent spans all in-flight paths of the row (multi-shard)', () => {
  // Two shards hashing: 50 of 100 and 25 of 100 → 75 of 200 → 37%.
  const progress = new Map<string, AuditProgressEvent>([
    ['s1.gguf', {file: 's1.gguf', hashedBytes: 50, totalBytes: 100}],
    ['s2.gguf', {file: 's2.gguf', hashedBytes: 25, totalBytes: 100}],
  ]);
  expect(
    rowAudit(
      ['s1.gguf', 's2.gguf'],
      new Set(['s1.gguf', 's2.gguf']),
      new Map(),
      true,
      progress,
    ),
  ).toEqual({kind: 'pending', percent: 37});
});

test('ignores progress of paths that do not belong to the row', () => {
  const progress = new Map<string, AuditProgressEvent>([
    ['other.gguf', {file: 'other.gguf', hashedBytes: 99, totalBytes: 100}],
  ]);
  expect(
    rowAudit(['a.gguf'], new Set(['a.gguf']), new Map(), true, progress),
  ).toEqual({kind: 'pending'});
});
