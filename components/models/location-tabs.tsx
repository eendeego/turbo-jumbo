'use client';

import {TabList, Tab} from '@astryxdesign/core/TabList';

export interface LocationTab {
  id: string;
  label: string;
  isLocal: boolean;
}

// The All / per-peer / Cold Storage tab row that drives the active location.
export function LocationTabs({
  locations,
  activeLocation,
  onLocationChange,
}: {
  locations: LocationTab[];
  activeLocation: string;
  onLocationChange: (id: string) => void;
}) {
  return (
    <TabList value={activeLocation} onChange={onLocationChange}>
      <Tab value="all" label="All" />
      {locations.map((loc) => (
        <Tab
          key={loc.id}
          value={loc.id}
          label={loc.isLocal ? `${loc.label} (local)` : loc.label}
        />
      ))}
      <Tab value="cold-storage" label="Cold Storage" />
    </TabList>
  );
}
