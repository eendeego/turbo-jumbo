# HF Modal Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `HfDownloadPicker` visually consistent with the Lemonade browser: fixed-height scrolling body, Lemonade-style footer, right-aligned row sizes, titled terminal dialog.

**Architecture:** All changes are inside `components/hf-download/hf-download-picker.tsx`; the StyleX rules are copied from `components/lemonade/lemonade-browser.tsx`.

**Tech Stack:** React 19, Astryx components, StyleX (`@stylexjs/stylex`), Bun, Jujutsu.

Spec: `docs/plans/2026-07-02-hf-modal-consistency-design.md`

## Global Constraints

Same as the previous modal plans: Bun + jj (no Co-Authored-By), StyleX via the `xstyle` prop with no raw hex (viewport/flex values are fine, matching `lemonade-browser.tsx`), verify with `bun dev` on http://localhost:3000.

---

### Task 1: Align the picker with the Lemonade browser

**Files:**
- Modify: `components/hf-download/hf-download-picker.tsx`

- [ ] **Step 1: Add StyleX styles and imports**

At the top of the file, next to the existing imports:

```tsx
import * as stylex from '@stylexjs/stylex';
```

Below the imports (before the `HfFile` type):

```tsx
const styles = stylex.create({
  // Fixed-height body, matching the Lemonade browser: the dialog must not
  // resize as the file list loads or the filter narrows.
  pickerBody: {height: '55vh', minHeight: 0},
  fileList: {flexGrow: 1, minHeight: 0, overflowY: 'auto'},
});
```

- [ ] **Step 2: Fix the body height, add the empty-state hint, scroll the list**

- Body wrapper: `<VStack gap={3}>` → `<VStack gap={3} xstyle={styles.pickerBody}>`
- After the `filesError` line, add the pre-URL hint:

```tsx
        {!hasFiles && !filesLoading && !filesError && (
          <Text type="supporting">
            Enter a Hugging Face URL or org/repo to list its files.
          </Text>
        )}
```

  (`hasFiles` is declared above the `showTerminal` early return, so it is in
  scope here.)
- List: `<List hasDividers>` → `<List hasDividers xstyle={styles.fileList}>`

- [ ] **Step 3: Row sizes to right-aligned end content**

In the file `ListItem`, replace `description={formatBytes(f.size)}` with:

```tsx
                endContent={<Text type="supporting">{formatBytes(f.size)}</Text>}
```

- [ ] **Step 4: Footer parity**

Replace the footer block (currently gated on `hasFiles`) with an unconditional
one; the summary shows "Nothing selected" at zero and the primary button is
"Download":

```tsx
      <HStack gap={2} hAlign="between" vAlign="center">
        <Text type="supporting">
          {selectedFiles.length === 0
            ? 'Nothing selected'
            : `${selectedFiles.length} file${
                selectedFiles.length !== 1 ? 's' : ''
              } · ${formatBytes(totalSize)}`}
        </Text>
        <HStack gap={2} hAlign="end">
          <Button
            label={copied ? 'Copied' : 'Copy command'}
            variant="secondary"
            size="sm"
            onClick={handleCopy}
            isDisabled={command == null}
          />
          <Button
            label="Download"
            variant="primary"
            size="sm"
            onClick={startDownload}
            isDisabled={selectedFiles.length === 0}
          />
        </HStack>
      </HStack>
```

- [ ] **Step 5: Terminal title**

In the `showTerminal` early return, add a title prop to `DownloadModal`:

```tsx
        title={parsed ? `Downloading ${parsed.repoId}…` : undefined}
```

- [ ] **Step 6: Verify**

Run: `bun typecheck && bun lint && bun test`
Expected: pass.

Then `bun dev` and in a browser on `/download/hf`: the modal opens at a
stable 55vh-body size showing the hint and a footer with "Nothing selected" +
disabled Download; entering `unsloth/Qwen3-0.6B-GGUF` fills the list without
changing the dialog's outer size; the list scrolls internally with the footer
pinned; sizes right-aligned; checking files updates the summary and enables
Download; the filter narrows the list without resizing the dialog.

- [ ] **Step 7: Commit**

```bash
jj commit -m "Match the HF download modal's design to the Lemonade modal"
```

---

### Task 2: Final verification

- [ ] **Step 1: Build**

Run: `bun run build`
Expected: passes.
