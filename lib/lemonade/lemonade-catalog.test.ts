import {test, expect} from 'bun:test';
import {
  selectionKey,
  selectionLabel,
  uniq,
  checkpointsIncomplete,
  formatGb,
  type Selection,
} from '@/lib/lemonade/lemonade-catalog';
import type {
  Checkpoint,
  LemonadeComponent,
  LemonadeModel,
  OmniCollection,
} from '@/lib/lemonade/lemonade';

const model = {name: 'Qwen3-4B', sizeGb: 2.5} as LemonadeModel;
const component = {name: 'unet', sizeGb: 1.25} as LemonadeComponent;
const collection = {name: 'Flux', sizeGb: 12} as OmniCollection;

test('selectionKey is distinct per selection kind', () => {
  const keys = [
    selectionKey({kind: 'model', model}),
    selectionKey({kind: 'standalone', component}),
    selectionKey({kind: 'collection', collection}),
    selectionKey({kind: 'component', collectionName: 'Flux', component}),
  ];
  expect(keys).toEqual([
    'model:Qwen3-4B',
    'standalone:unet',
    'coll:Flux',
    'comp:Flux:unet',
  ]);
  // No two kinds collide.
  expect(new Set(keys).size).toBe(4);
});

test('selectionLabel takes title + size from the selected entity', () => {
  expect(selectionLabel({kind: 'model', model})).toEqual({
    title: 'Qwen3-4B',
    sizeGb: 2.5,
  });
  expect(selectionLabel({kind: 'collection', collection})).toEqual({
    title: 'Flux',
    sizeGb: 12,
  });
  // A component (standalone or within a collection) labels by the component.
  const sel: Selection = {kind: 'component', collectionName: 'Flux', component};
  expect(selectionLabel(sel)).toEqual({title: 'unet', sizeGb: 1.25});
});

test('uniq drops duplicates, preserving first-seen order', () => {
  expect(uniq(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
});

test('checkpointsIncomplete is true iff some repo is in the incomplete set', () => {
  const cps = [{repoId: 'org/a'}, {repoId: 'org/b'}] as Checkpoint[];
  expect(checkpointsIncomplete(cps, new Set(['org/b']))).toBe(true);
  expect(checkpointsIncomplete(cps, new Set(['org/x']))).toBe(false);
  expect(checkpointsIncomplete([], new Set(['org/a']))).toBe(false);
});

test('formatGb prints two decimals with a GB suffix', () => {
  expect(formatGb(2)).toBe('2.00 GB');
  expect(formatGb(12.345)).toBe('12.35 GB');
});
