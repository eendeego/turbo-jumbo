import {test, expect} from 'bun:test';
import {
  LABEL_DESCRIPTIONS,
  LABEL_DISPLAY_ORDER,
  sortLabelsForDisplay,
} from '@/lib/lemonade/lemonade-labels';

test('sortLabelsForDisplay orders known labels by the display order', () => {
  expect(sortLabelsForDisplay(['vision', 'reasoning', 'coding'])).toEqual([
    'reasoning',
    'coding',
    'vision',
  ]);
});

test('sortLabelsForDisplay places unknown labels last, in input order', () => {
  expect(
    sortLabelsForDisplay(['zeta', 'vision', 'alpha', 'reasoning']),
  ).toEqual(['reasoning', 'vision', 'zeta', 'alpha']);
});

test('every label in the display order has a hover description', () => {
  for (const label of LABEL_DISPLAY_ORDER) {
    expect(LABEL_DESCRIPTIONS[label]).toBeDefined();
  }
});
