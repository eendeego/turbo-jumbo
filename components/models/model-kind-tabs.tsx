'use client';

import {TabList, Tab} from '@astryxdesign/core/TabList';

export type ModelKind = 'turbo-jumbo' | 'lemonade';

// The Turbo Jumbo / Lemonade sub-tab row shown on peer/local pages.
export function ModelKindTabs({
  value,
  onChange,
}: {
  value: ModelKind;
  onChange: (kind: ModelKind) => void;
}) {
  return (
    <TabList value={value} onChange={(v) => onChange(v as ModelKind)}>
      <Tab value="turbo-jumbo" label="Turbo Jumbo" />
      <Tab value="lemonade" label="Lemonade" />
    </TabList>
  );
}
