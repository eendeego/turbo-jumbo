'use client';

import {useEffect, useState} from 'react';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import type {Peer as PeerConfig} from '@/lib/config';
import {
  formatBytes,
  type DiskUsage,
  type DownloadDiskUsage,
} from '@/lib/storage/disk-space';

// Free space moves with downloads/copies/deletes elsewhere on the system too,
// so keep the figures fresh while the tab stays open. statfs is cheap.
const REFRESH_MS = 60_000;

function usageLine(label: string, u: DiskUsage): string {
  return `${label}: ${formatBytes(u.total - u.free)} used · ${formatBytes(u.free)} free of ${formatBytes(u.total)}`;
}

/**
 * Disk usage of the active location's volumes — used / free / total per
 * volume — shown in the footer above the action bar. Peer tabs report that
 * peer's own disks (proxied for remote peers); the Cold Storage tab reports
 * the local cold-storage volume. Nothing on the All tab, and silent when the
 * figures can't be fetched (e.g. the peer is down).
 */
export function DiskStats({
  activeLocation,
  peers,
}: {
  activeLocation: string;
  peers: PeerConfig[];
}) {
  // Keyed by the URL it came from, so switching tabs never shows the previous
  // location's figures while the new fetch is in flight.
  const [fetched, setFetched] = useState<{
    url: string;
    data: DownloadDiskUsage;
  } | null>(null);

  const peer = peers.find((p) => p.address === activeLocation);
  const url =
    activeLocation === 'cold-storage' || peer?.isLocal
      ? '/api/v1/disk-usage'
      : peer
        ? `/api/v1/peers/${encodeURIComponent(peer.name)}/disk-usage`
        : null;

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<DownloadDiskUsage>) : null))
        .then((d) => {
          if (!cancelled && d) setFetched({url, data: d});
        })
        .catch(() => {
          /* peer down or unreadable disk: show nothing */
        });
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url]);

  const usage = fetched && fetched.url === url ? fetched.data : null;
  if (!usage) return null;

  const lines: string[] = [];
  if (activeLocation === 'cold-storage') {
    if (usage.cold.total > 0) lines.push(usageLine('Cold storage', usage.cold));
  } else if (usage.sameDevice) {
    // One filesystem behind both paths: a combined line, not double-counted.
    lines.push(usageLine('Disk (models + cold storage)', usage.models));
  } else {
    lines.push(usageLine('Models', usage.models));
    if (usage.cold.total > 0) lines.push(usageLine('Cold storage', usage.cold));
  }
  if (lines.length === 0) return null;

  return (
    <HStack gap={4} wrap="wrap">
      {lines.map((l) => (
        <Text key={l} type="supporting">
          {l}
        </Text>
      ))}
    </HStack>
  );
}
