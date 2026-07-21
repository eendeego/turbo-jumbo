/**
 * Byte sizes and transfer rates in binary units (÷1024) — the single formatter
 * the whole app uses, so file, model, disk-usage and download-progress sizes
 * always read the same way (GiB/MiB/KiB). The Lemonade catalog is the one
 * exception: it shows the GB figure its own spec lists (see `formatGb`), a value
 * it authors rather than a byte count we measured.
 */

/** A byte count as "18.7 GiB" / "512 KiB" / "900 B". Negative → ''. */
export function formatSize(bytes: number): string {
  if (bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${(bytes / 1024 ** 4).toFixed(1)} TiB`;
}

/** A transfer rate as "72.3 MiB/s". */
export function formatSpeed(bps: number): string {
  if (bps >= 1024 ** 3) return `${(bps / 1024 ** 3).toFixed(2)} GiB/s`;
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MiB/s`;
  return `${(bps / 1024).toFixed(0)} KiB/s`;
}
