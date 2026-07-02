import {test, expect} from 'bun:test';
import {isClutterFile} from '@/lib/models/repo-clutter';

test('isClutterFile flags repo metadata and docs, ignoring directory prefix', () => {
  expect(isClutterFile('.gitattributes')).toBe(true);
  expect(isClutterFile('.gitignore')).toBe(true);
  expect(isClutterFile('LICENSE')).toBe(true);
  expect(isClutterFile('README.md')).toBe(true);
  expect(isClutterFile('docs/notes.txt')).toBe(true);
  expect(isClutterFile('assets/preview.png')).toBe(true);
});

test('isClutterFile leaves model files alone', () => {
  expect(isClutterFile('split_files/vae/flux2-vae.safetensors')).toBe(false);
  expect(isClutterFile('config.json')).toBe(false);
  expect(isClutterFile('model.safetensors.index.json')).toBe(false);
  expect(isClutterFile('model.gguf')).toBe(false);
});
