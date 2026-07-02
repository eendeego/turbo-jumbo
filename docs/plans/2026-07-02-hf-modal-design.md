# Hugging Face downloader as an intercepted-route modal

**Date:** 2026-07-02
**Status:** Approved

## Summary

Move the "Add from Hugging Face" downloader from a full page into a modal,
**exactly mirroring the Lemonade modal**
(`docs/plans/2026-07-01-lemonade-modal-design.md`): an Astryx `Dialog` opened
through the existing `@modal` parallel slot, with intercepted routes for soft
navigation and table-plus-open-modal pages for hard navigation. No full-page
HF view remains.

**URLs do not change**: `/download/hf` (All) and `/<peer-slug>/download/hf`.
`hfHref`, `AddModelMenu`, and `AppChrome`'s pathname parsing keep working
as-is. Cold Storage has neither download view.

## Route structure

The `(chrome)` group, `@modal` slot, and both risks were established and
verified by the Lemonade work; this only adds sibling `hf/` folders:

```
app/(chrome)/
  @modal/
    (.)download/hf/page.tsx               intercepts soft nav to /download/hf
    (.)[location]/download/hf/page.tsx    intercepts /<peer>/download/hf
  download/hf/page.tsx                    hard nav: All table + open modal
  [location]/download/hf/page.tsx         hard nav: peer table + open modal
  [[...location]]/page.tsx                table only (hf branch removed)
```

With both download views on explicit routes, the catch-all page always renders
`HomeView`; `parseRoute` still recognizes the download paths for `AppChrome`'s
active-location derivation.

## Components

- **`components/hf-download/hf-download-modal.tsx`** — client component,
  structured identically to `LemonadeModal`: `Dialog`
  (`width="min(1100px, 92vw)"`, `maxHeight="85vh"`, `purpose="form"`) with a
  `DialogHeader` titled "Add from Hugging Face" and `HfDownloadPicker` as the
  body. Close = `router.replace(locationHref(activeLocation))`; renders only
  while `usePathname()` ends with `/download/hf` (stale-slot guard).
- **`components/hf-download/hf-download-modal-route.tsx`** — server component
  `HfDownloadModalRoute({location})`. The HF view needs no filesystem scans,
  only config (peer list, local models path, HF-token flag).
- **`components/hf-download/hf-download-picker.tsx`** — loses its internal
  heading/Back row and the `onClose` prop (the Back button was its only use);
  the `DialogHeader` owns title and close now. **Accepted simplification:**
  the dynamic "Download from <repoId>" heading goes away — the modal title is
  static, and the repo id is visible in the URL input. The `DownloadModal`
  terminal takeover keeps working; as a native `<dialog>` it stacks above the
  picker's dialog (same as the Lemonade browser's download flow).
- **`components/hf-download/hf-download-client.tsx`** — deleted.

## Error handling

Same as Lemonade: unknown slug or Cold Storage under `/…/download/hf` 404s on
hard nav (`notFound()` in the real route) and renders no modal on soft nav
(interceptor returns null; unreachable from the app UI).

## Testing

`lib/` is untouched, so existing tests stand. `bun typecheck`, `bun lint`,
`bun test`, production build. Manual matrix as for Lemonade with `hf` in place
of `lemonade`, plus: entering a repo URL in the modal resolves the file list,
and Run swaps to the terminal dialog and back.
