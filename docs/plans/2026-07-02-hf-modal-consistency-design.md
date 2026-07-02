# HF download modal: design consistency with the Lemonade modal

**Date:** 2026-07-02
**Status:** Approved

## Summary

Align the "Add from Hugging Face" modal body (`HfDownloadPicker`) with the
Lemonade modal's design. The two already share the Dialog frame, header,
disk-space banner, cold-storage checkboxes, and the terminal takeover; four
inconsistencies remain, all in the HF picker.

## Changes

1. **Fixed-height body with an internally scrolling list.** The Lemonade
   browser pins its body at `55vh` (`pickerBody`) and lets the list scroll
   inside (`flexGrow: 1; overflowY: auto`) so the dialog never resizes as
   content loads or the filter narrows — a pattern originally copied *from*
   the old HF modal and since lost. Reintroduce it: the same two StyleX rules
   on the picker's body `VStack` and file `List`. Before a URL is entered the
   body shows a supporting hint — "Enter a Hugging Face URL or org/repo to
   list its files." — mirroring Lemonade's "Fetching the catalog…"
   placeholder.
2. **Footer parity.** Render the footer unconditionally (Lemonade's is always
   visible; buttons disable themselves). Left text reads "Nothing selected"
   when no file is checked, otherwise "N files · ⟨size⟩". The primary button
   is renamed **Run → Download**; "Copy command" stays as the HF-specific
   secondary button.
3. **File rows.** The size moves from the `description` slot (under the
   filename) to right-aligned supporting `endContent`, like the catalog rows.
4. **Terminal title.** Pass `Downloading ⟨repoId⟩…` to `DownloadModal`
   instead of falling back to the generic "Downloading…", like the Lemonade
   browser's `Downloading ⟨name⟩…`.

## Deliberately unchanged

The URL input in place of Lemonade's "Catalog:" line (different sources),
checkbox multi-select rows vs Lemonade's single-select rows (different
semantics), and byte-precise file sizes (`formatBytes`) vs Lemonade's GB
rounding.

## Testing

No `lib/` changes. `bun typecheck`, `bun lint`, `bun test`, production build.
Manual: the modal opens at a stable size with the hint and a disabled footer;
resolving a repo URL fills the list without resizing the dialog; filtering
scrolls/narrows the list only; sizes sit right-aligned; selection text and the
Download button behave like Lemonade's; Run(now Download) still opens the
terminal dialog, titled with the repo id.
