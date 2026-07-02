// Copy text to the clipboard, falling back to a hidden textarea on browsers
// without the async Clipboard API (or where it's blocked by permissions).
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  fallbackCopy(text);
  return Promise.resolve();
}

function fallbackCopy(text: string) {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.cssText = 'position:fixed;opacity:0';
  // A modal <dialog> (showModal) makes everything outside it inert, so a
  // textarea on document.body couldn't be focused or selected and execCommand
  // would copy an empty selection. Mount inside the open dialog when there is
  // one.
  const host = document.querySelector('dialog[open]') ?? document.body;
  host.appendChild(el);
  el.focus();
  el.select();
  document.execCommand('copy');
  host.removeChild(el);
}
