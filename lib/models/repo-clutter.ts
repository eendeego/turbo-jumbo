// Repo files a complete, runnable model doesn't depend on — pure docs/images and
// git/repo metadata. A missing one of these is never an incomplete download, and
// it's never a "required" file. Intentionally dependency-free so both the server
// scanner (incomplete-models, repo-files) and client bundles can import it.
const CLUTTER_EXT = /\.(md|txt|png|jpe?g|gif|webp|svg|pdf)$/i;
const CLUTTER_NAME = /^(\.gitattributes|\.gitignore|license.*|readme.*)$/i;

/** Whether a path names repo clutter — docs/images or git/repo metadata
 *  (`.gitattributes`, license, readme, …) — ignoring any directory prefix. */
export function isClutterFile(p: string): boolean {
  const name = p.split('/').pop() ?? p;
  return CLUTTER_EXT.test(name) || CLUTTER_NAME.test(name);
}
