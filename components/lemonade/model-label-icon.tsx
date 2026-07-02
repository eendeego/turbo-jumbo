import {
  ArrowsUpDownIcon,
  BoltIcon,
  CommandLineIcon,
  CpuChipIcon,
  LightBulbIcon,
  MicrophoneIcon,
  PhotoIcon,
  PuzzlePieceIcon,
  Squares2X2Icon,
  StarIcon,
} from '@heroicons/react/24/outline';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {Icon, type IconType} from '@astryxdesign/core/Icon';
import {LABEL_DESCRIPTIONS} from '@/lib/lemonade/lemonade-labels';

// One Heroicon per capability label. Deliberately distinct metaphors from
// lemonade's lucide set (../lemonade ModalityIcon): Eye→Photo, Flame→Star,
// Wrench→Puzzle, Brain→Bulb, SquareCode→CommandLine, Layers→Squares,
// ListOrdered→Arrows.
const LABEL_ICONS: Record<string, IconType> = {
  reasoning: LightBulbIcon,
  coding: CommandLineIcon,
  vision: PhotoIcon,
  'tool-calling': PuzzlePieceIcon,
  hot: StarIcon,
  embeddings: Squares2X2Icon,
  reranking: ArrowsUpDownIcon,
  mtp: BoltIcon,
  'chat-transcription': MicrophoneIcon,
  llamacpp: CpuChipIcon,
};

/**
 * One capability label shown as a small icon with a hover description. A label
 * with no mapped icon falls back to the gray badge, so an unknown or future
 * label never silently disappears.
 */
export function ModelLabelIcon({label}: {label: string}) {
  const iconComponent = LABEL_ICONS[label];
  if (!iconComponent) return <Badge label={label} variant="neutral" />;
  return (
    <HoverCard placement="above" content={LABEL_DESCRIPTIONS[label] ?? label}>
      <Icon icon={iconComponent} size="sm" />
    </HoverCard>
  );
}
