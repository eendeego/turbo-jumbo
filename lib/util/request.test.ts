import {test, expect} from 'bun:test';
import {
  readJsonBody,
  isObject,
  isStringArray,
  hasStringFiles,
  hasOptionalStringFiles,
} from '@/lib/util/request';

const jsonReq = (raw: string) =>
  new Request('http://test/', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: raw,
  });

test('readJsonBody returns the parsed body for valid JSON', async () => {
  const body = await readJsonBody<{a: number}>(jsonReq('{"a":1}'));
  expect(body).toEqual({a: 1});
});

test('readJsonBody returns a 400 Response for malformed JSON', async () => {
  const body = await readJsonBody(jsonReq('{not json'));
  expect(body).toBeInstanceOf(Response);
  expect((body as Response).status).toBe(400);
});

test('readJsonBody returns a 400 Response when validate fails', async () => {
  const body = await readJsonBody(jsonReq('[1,2,3]'), isObject);
  expect(body).toBeInstanceOf(Response);
  expect((body as Response).status).toBe(400);
});

test('readJsonBody passes a body that satisfies validate', async () => {
  const body = await readJsonBody<{files: string[]}>(
    jsonReq('{"files":["a","b"]}'),
    hasStringFiles,
  );
  expect(body).toEqual({files: ['a', 'b']});
});

test('isObject rejects null and arrays', () => {
  expect(isObject({})).toBe(true);
  expect(isObject(null)).toBe(false);
  expect(isObject([1, 2])).toBe(false);
  expect(isObject('x')).toBe(false);
});

test('isStringArray accepts only arrays of strings', () => {
  expect(isStringArray(['a', 'b'])).toBe(true);
  expect(isStringArray([])).toBe(true);
  expect(isStringArray(['a', 1])).toBe(false);
  expect(isStringArray('a')).toBe(false);
});

test('hasStringFiles requires a string-array files field', () => {
  expect(hasStringFiles({files: ['a']})).toBe(true);
  expect(hasStringFiles({files: ['a'], dryRun: true})).toBe(true);
  expect(hasStringFiles({})).toBe(false);
  expect(hasStringFiles({files: 'a'})).toBe(false);
  expect(hasStringFiles({files: [1]})).toBe(false);
});

test('hasOptionalStringFiles allows files to be absent but not malformed', () => {
  expect(hasOptionalStringFiles({})).toBe(true);
  expect(hasOptionalStringFiles({location: 'x'})).toBe(true);
  expect(hasOptionalStringFiles({files: ['a']})).toBe(true);
  expect(hasOptionalStringFiles({files: 42})).toBe(false);
  expect(hasOptionalStringFiles(null)).toBe(false);
});
