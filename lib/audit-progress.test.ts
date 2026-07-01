import {test, expect} from 'bun:test';
import {hashProgressEmitter} from '@/lib/audit-progress';
import type {AuditProgressEvent} from '@/lib/audit';

test('emits the first progress event for the file', () => {
  const seen: AuditProgressEvent[] = [];
  const report = hashProgressEmitter(
    'a.gguf',
    (e) => seen.push(e),
    500,
    () => 1000,
  );
  report(10, 100);
  expect(seen).toEqual([{file: 'a.gguf', hashedBytes: 10, totalBytes: 100}]);
});

test('drops events inside the rate-limit interval', () => {
  let now = 1000;
  const seen: AuditProgressEvent[] = [];
  const report = hashProgressEmitter(
    'a.gguf',
    (e) => seen.push(e),
    500,
    () => now,
  );
  report(10, 100);
  now += 100;
  report(20, 100); // dropped
  now += 400;
  report(30, 100); // 500ms after the first — fires
  expect(seen.map((e) => e.hashedBytes)).toEqual([10, 30]);
});

test('always emits the final event, even inside the interval', () => {
  let now = 1000;
  const seen: AuditProgressEvent[] = [];
  const report = hashProgressEmitter(
    'a.gguf',
    (e) => seen.push(e),
    500,
    () => now,
  );
  report(10, 100);
  now += 1;
  report(100, 100); // final — fires despite the interval
  expect(seen.map((e) => e.hashedBytes)).toEqual([10, 100]);
});
