'use client';

import {useState} from 'react';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {copyToClipboard} from '@/lib/clipboard';

/**
 * A small clipboard icon that copies a model or file name. Flips to a check
 * mark for a moment after a successful copy so the click registers visibly.
 */
export function CopyNameButton({name}: {name: string}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    copyToClipboard(name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <IconButton
      label={`Copy name ${name}`}
      icon={<Icon icon={copied ? 'check' : 'copy'} size="sm" />}
      variant="ghost"
      size="sm"
      tooltip={copied ? 'Copied' : 'Copy name'}
      onClick={copy}
    />
  );
}
