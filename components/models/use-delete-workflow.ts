import {useMemo, useState, type Dispatch, type SetStateAction} from 'react';
import {useRouter} from 'next/navigation';
import type {Peer as PeerConfig} from '@/lib/config';

/**
 * The delete workflow: the confirm flag, the in-flight state, the "delete
 * from <where>" label, and `onDelete`, which fans out a delete to every
 * affected location and rescans them. The shared selection and the various
 * refreshers are passed in.
 */
export function useDeleteWorkflow({
  selected,
  setSelected,
  activeLocation,
  peerConfigs,
  refreshModels,
  refreshPeerModels,
  refreshIncomplete,
  refreshInvalid,
  setError,
}: {
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  activeLocation: string;
  peerConfigs: PeerConfig[];
  refreshModels: () => Promise<void>;
  refreshPeerModels: (peer: PeerConfig) => Promise<void>;
  refreshIncomplete: () => Promise<void>;
  refreshInvalid: () => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deleteFromLabel = useMemo(() => {
    if (activeLocation === 'all') return 'all locations';
    if (activeLocation === 'cold-storage') return 'cold storage';
    const peer = peerConfigs.find((p) => p.address === activeLocation);
    if (!peer) return undefined;
    return peer.isLocal ? `${peer.name} (local)` : peer.name;
  }, [activeLocation, peerConfigs]);

  async function onDelete(dryRun: boolean, keepCold: boolean) {
    setConfirming(false);
    setDeleting(true);
    setError(null);
    try {
      const headers = {'Content-Type': 'application/json'};
      const body = JSON.stringify({
        files: Array.from(selected),
        ...(dryRun ? {dryRun: true} : {}),
      });

      if (activeLocation === 'all') {
        // Delete from every location in parallel — sparing cold storage when
        // the user asked to keep the cold backup.
        const requests: Promise<Response>[] = [
          fetch('/api/v1/local-models', {method: 'DELETE', headers, body}),
          ...(keepCold
            ? []
            : [
                fetch('/api/v1/cold-storage', {
                  method: 'DELETE',
                  headers,
                  body,
                }),
              ]),
          ...peerConfigs
            .filter((p) => !p.isLocal)
            .map((p) =>
              fetch(`/api/v1/peers/${encodeURIComponent(p.name)}/models`, {
                method: 'DELETE',
                headers,
                body,
              }),
            ),
        ];
        const results = await Promise.allSettled(requests);
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length > 0)
          throw new Error(`${failed.length} delete request(s) failed`);
      } else {
        let url: string;
        if (activeLocation === 'cold-storage') {
          url = '/api/v1/cold-storage';
        } else {
          const peer = peerConfigs.find((p) => p.address === activeLocation);
          if (!peer) throw new Error('Unknown location');
          url = `/api/v1/peers/${encodeURIComponent(peer.name)}/models`;
        }
        const del = await fetch(url, {method: 'DELETE', headers, body});
        if (!del.ok) throw new Error(`${del.status} ${del.statusText}`);
      }

      setSelected(new Set());
      // Force an immediate rescan everywhere the table reads from instead of
      // waiting for the next poll. refreshModels() refreshes the models state
      // (the local + cold storage rows) and router.refresh() re-renders the
      // server component (the cold-storage and local-models props), but the
      // table also filters and synthesizes peer-tab rows from the client-polled
      // peerModels map, which neither touches — so rescan every affected peer
      // too. Run them together so the row drops as soon as the scans return.
      const peersToRescan =
        activeLocation === 'all'
          ? peerConfigs
          : activeLocation === 'cold-storage'
            ? []
            : peerConfigs.filter((p) => p.address === activeLocation);
      router.refresh();
      await Promise.all([
        refreshModels(),
        ...peersToRescan.map((p) => refreshPeerModels(p)),
        refreshIncomplete(),
        refreshInvalid(),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return {confirming, setConfirming, deleting, deleteFromLabel, onDelete};
}
