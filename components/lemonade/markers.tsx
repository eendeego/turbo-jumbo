'use client';

import {ListItem} from '@astryxdesign/core/List';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {lemonadeStatusTooltip, type LemonadeDownloadInfo} from '@/lib/lemonade';

// A clickable divider titling a modality section in the catalog list; toggles
// the section's collapsed state.
export function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <ListItem
      label={label}
      description={
        count != null ? `${count} model${count === 1 ? '' : 's'}` : undefined
      }
      onClick={onToggle}
      startContent={
        <IconButton
          label={collapsed ? 'Expand' : 'Collapse'}
          variant="ghost"
          size="sm"
          icon={<Icon icon={collapsed ? 'chevronRight' : 'chevronDown'} />}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        />
      }
    />
  );
}

// The download-status marker shared by model rows and collection children.
export function StatusMarker({info}: {info: LemonadeDownloadInfo | undefined}) {
  if (!info || info.status === 'none') return null;
  return (
    <HoverCard placement="above" content={lemonadeStatusTooltip(info)}>
      <Badge
        label={info.status === 'complete' ? 'downloaded' : 'partial'}
        variant={info.status === 'complete' ? 'blue' : 'orange'}
      />
    </HoverCard>
  );
}

// Flags an entry that lives in Lemonade's own cache directory — separate from
// the managed storage the download-status marker reports on. Shown alongside
// it, so an entry can carry both, one, or neither. `muted` dims the badge for a
// collection only partially present in the cache.
export function LemonadeCacheMarker({
  present,
  muted = false,
}: {
  present: boolean;
  muted?: boolean;
}) {
  if (!present) return null;
  return (
    <HoverCard
      placement="above"
      content={
        muted
          ? "Partially in Lemonade's local cache"
          : "In Lemonade's local cache"
      }
    >
      <span style={muted ? {opacity: 0.45} : undefined}>
        <Badge label="lemonade" variant="yellow" />
      </span>
    </HoverCard>
  );
}

// Flags a model whose local copy is missing files a full download would
// include (e.g. a Kokoro repo with only its voices sidecar, no .onnx model).
export function IncompleteMarker({incomplete}: {incomplete: boolean}) {
  if (!incomplete) return null;
  return <Badge variant="error" label="incomplete" />;
}
