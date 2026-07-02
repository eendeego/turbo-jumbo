import {test, expect} from 'bun:test';
import {
  coldStorageRollup,
  type RollupQuant,
} from '@/lib/storage/cold-storage-rollup';

const weight = (over: Partial<RollupQuant> = {}): RollupQuant => ({
  coldComplete: true,
  inColdStorage: true,
  ...over,
});
const projector = (over: Partial<RollupQuant> = {}): RollupQuant => ({
  coldComplete: true,
  inColdStorage: true,
  isProjector: true,
  ...over,
});

test('a weights-only model fully in cold is Complete', () => {
  expect(coldStorageRollup([weight(), weight()])).toEqual({
    allInColdStorage: true,
    noneInColdStorage: false,
  });
});

test('a model is Partial when its projector is not in cold but weights are', () => {
  // The 27B-MTP case: both weights cold-complete, mmproj absent from cold.
  const rollup = coldStorageRollup([
    weight(),
    weight(),
    projector({coldComplete: false, inColdStorage: false}),
  ]);
  expect(rollup.allInColdStorage).toBe(false);
  expect(rollup.noneInColdStorage).toBe(false);
});

test('a model is Complete when both weights and projector are in cold', () => {
  expect(coldStorageRollup([weight(), projector()]).allInColdStorage).toBe(
    true,
  );
});

test('a model with nothing in cold is Missing (none in cold)', () => {
  const rollup = coldStorageRollup([
    weight({coldComplete: false, inColdStorage: false}),
    projector({coldComplete: false, inColdStorage: false}),
  ]);
  expect(rollup.allInColdStorage).toBe(false);
  expect(rollup.noneInColdStorage).toBe(true);
});

test('an incomplete (size-mismatched) weight is not Complete', () => {
  // Present by name but wrong size: inColdStorage but not coldComplete.
  const rollup = coldStorageRollup([weight({coldComplete: false})]);
  expect(rollup.allInColdStorage).toBe(false);
  expect(rollup.noneInColdStorage).toBe(false);
});
