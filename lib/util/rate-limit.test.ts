import {test, expect} from 'bun:test';
import {rateLimited} from '@/lib/util/rate-limit';

test('passes the first call through and drops calls inside the interval', () => {
  let now = 1000;
  const seen: number[] = [];
  const fn = rateLimited(
    500,
    (n: number) => seen.push(n),
    () => now,
  );

  fn(1); // first call always fires
  now += 100;
  fn(2); // 100ms later — dropped
  now += 100;
  fn(3); // 200ms after the last fire — dropped
  expect(seen).toEqual([1]);
});

test('fires again once the interval has elapsed', () => {
  let now = 1000;
  const seen: number[] = [];
  const fn = rateLimited(
    500,
    (n: number) => seen.push(n),
    () => now,
  );

  fn(1);
  now += 500;
  fn(2); // exactly the interval — fires
  now += 499;
  fn(3); // dropped
  now += 1;
  fn(4); // fires
  expect(seen).toEqual([1, 2, 4]);
});

test('forwards every argument of the calls that fire', () => {
  const seen: Array<[number, number]> = [];
  const fn = rateLimited(0, (a: number, b: number) => seen.push([a, b]));
  fn(7, 42);
  expect(seen).toEqual([[7, 42]]);
});
