'use client';

import {useRouter} from 'next/navigation';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import type {Peer as PeerConfig} from '@/lib/config';
import {hfHref, lemonadeHref} from '@/lib/storage/locations';

// "Add model" dropdown: a single trigger that navigates to either download
// source's route. Shown wherever downloads can be initiated (the All view and
// the local peer), so the table and the Lemonade page share one entry point.
export function AddModelMenu({
  activeLocation,
  peerConfigs,
  isDisabled,
}: {
  activeLocation: string;
  peerConfigs: PeerConfig[];
  isDisabled?: boolean;
}) {
  const router = useRouter();
  return (
    <DropdownMenu
      button={{
        label: 'Add model',
        variant: 'secondary',
        size: 'sm',
        isDisabled,
      }}
      hasChevron
      items={[
        {
          label: 'From Hugging Face',
          onClick: () => router.push(hfHref(activeLocation, peerConfigs)),
        },
        {
          label: 'From Lemonade',
          onClick: () => router.push(lemonadeHref(activeLocation, peerConfigs)),
        },
      ]}
    />
  );
}
