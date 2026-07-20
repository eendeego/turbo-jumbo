'use client';

import {useEffect, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {HStack, StackItem} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import type {Peer as PeerConfig} from '@/lib/config';
import {
  formatBytes,
  type DiskUsage,
  type DownloadDiskUsage,
} from '@/lib/storage/disk-space';

// Free space moves with downloads/copies/deletes elsewhere on the system too,
// so keep the figures fresh while the tab stays open. statfs is cheap.
const REFRESH_MS = 60_000;

const styles = stylex.create({
  // Inset to the action bar's content edge so the meters read as one footer
  // block with the buttons below them.
  root: {paddingInline: 'var(--spacing-3)'},
});

// Past this fill fraction the meter turns to the warning variant — the exact
// figures beside it carry the message for anyone who can't see the color.
const NEARLY_FULL = 0.9;

// One volume, filling its half: name at the start, exact figures at the end,
// and the meter stretching through the space between them. The meter carries
// the proportion; the numbers stay in text ink beside it.
function VolumeMeter({label, usage}: {label: string; usage: DiskUsage}) {
  const used = usage.total - usage.free;
  return (
    <HStack gap={3} vAlign="center" wrap="nowrap">
      <Text type="supporting" weight="medium" textWrap="nowrap">
        {label}
      </Text>
      <StackItem size="fill">
        <ProgressBar
          label={`${label} space used`}
          isLabelHidden
          value={used}
          max={usage.total}
          variant={used / usage.total >= NEARLY_FULL ? 'warning' : 'accent'}
        />
      </StackItem>
      <Text type="supporting" hasTabularNumbers textWrap="nowrap">
        {formatBytes(used)} used · {formatBytes(usage.free)} free of{' '}
        {formatBytes(usage.total)}
      </Text>
    </HStack>
  );
}

/**
 * Disk usage of the active location's volumes — a slim used/total meter plus
 * used / free / total figures per volume — shown in the footer above the
 * action bar. Peer tabs report that peer's own disks (proxied for remote
 * peers); the Cold Storage tab reports the local cold-storage volume. Nothing
 * on the All tab, and silent when the figures can't be fetched (e.g. the peer
 * is down).
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

  const volumes: Array<{label: string; usage: DiskUsage}> = [];
  if (activeLocation === 'cold-storage') {
    if (usage.cold.total > 0)
      volumes.push({label: 'Cold storage', usage: usage.cold});
  } else if (usage.sameDevice) {
    // One filesystem behind both paths: a combined meter, not double-counted.
    volumes.push({label: 'Models + cold storage', usage: usage.models});
  } else {
    volumes.push({label: 'Models', usage: usage.models});
    if (usage.cold.total > 0)
      volumes.push({label: 'Cold storage', usage: usage.cold});
  }
  if (volumes.length === 0) return null;

  // Two volumes split the strip into equal halves, each filled edge-to-edge
  // by its meter row; a single volume spans the full width.
  return (
    <HStack gap={8} vAlign="center" wrap="nowrap" xstyle={styles.root}>
      {volumes.map((v) => (
        <StackItem key={v.label} size="fill">
          <VolumeMeter label={v.label} usage={v.usage} />
        </StackItem>
      ))}
    </HStack>
  );
}
