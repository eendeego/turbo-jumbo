import {test, expect} from 'bun:test';
import {
  isDiffusersRepo,
  isDiffusersComponentFile,
  diffusersComponentKey,
} from '@/lib/diffusers';

// sdxl-turbo, present-only (fp16 pipeline downloaded), storage-relative paths.
const sdxlFp16 = [
  'stabilityai/sdxl-turbo/unet/diffusion_pytorch_model.fp16.safetensors',
  'stabilityai/sdxl-turbo/vae/diffusion_pytorch_model.fp16.safetensors',
  'stabilityai/sdxl-turbo/text_encoder/model.fp16.safetensors',
  'stabilityai/sdxl-turbo/text_encoder_2/model.fp16.safetensors',
];

test('isDiffusersRepo detects component-folder safetensors layout', () => {
  expect(isDiffusersRepo(sdxlFp16)).toBe(true);
  // repo-relative paths (the HF tree form) too
  expect(isDiffusersRepo(['unet/diffusion_pytorch_model.safetensors'])).toBe(
    true,
  );
});

test('isDiffusersRepo does not match a Comfy split_files bundle', () => {
  // `vae` appears, but under split_files/ — that's a pick-one bundle, not a
  // diffusers pipeline.
  expect(
    isDiffusersRepo([
      'split_files/vae/flux2-vae.safetensors',
      'split_files/text_encoders/qwen_3_8b.safetensors',
    ]),
  ).toBe(false);
});

test('isDiffusersRepo does not match a plain transformers model', () => {
  expect(
    isDiffusersRepo(['model.safetensors', 'config.json', 'tokenizer.json']),
  ).toBe(false);
});

test('isDiffusersComponentFile recognizes a weight in a component folder', () => {
  expect(
    isDiffusersComponentFile(
      'stabilityai/sdxl-turbo/unet/diffusion_pytorch_model.safetensors',
    ),
  ).toBe(true);
  expect(
    isDiffusersComponentFile('split_files/vae/flux2-vae.safetensors'),
  ).toBe(false);
  expect(isDiffusersComponentFile('model.safetensors')).toBe(false);
});

test('diffusersComponentKey splits component and precision', () => {
  expect(
    diffusersComponentKey('unet/diffusion_pytorch_model.fp16.safetensors'),
  ).toEqual({component: 'unet', precision: 'fp16'});
  expect(
    diffusersComponentKey('unet/diffusion_pytorch_model.safetensors'),
  ).toEqual({component: 'unet', precision: null});
  expect(
    diffusersComponentKey(
      'stabilityai/sdxl-turbo/text_encoder_2/model.fp16.safetensors',
    ),
  ).toEqual({component: 'text_encoder_2', precision: 'fp16'});
});

test('diffusersComponentKey treats a root single-file checkpoint as its own component', () => {
  expect(diffusersComponentKey('sd_xl_turbo_1.0_fp16.safetensors')).toEqual({
    component: 'sd_xl_turbo_1.0',
    precision: 'fp16',
  });
  expect(diffusersComponentKey('sd_xl_turbo_1.0.safetensors')).toEqual({
    component: 'sd_xl_turbo_1.0',
    precision: null,
  });
});
