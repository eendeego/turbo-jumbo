import {config, localPeer} from '@/lib/config';
import type {Model} from '@/lib/models/models';
import {publishPeerEvent} from './peer-event-hub';
import {logger} from '@/lib/util/logger';

const peerStatus = new Map<string, 'up' | 'down'>();

async function checkPeer(address: string): Promise<void> {
  try {
    const res = await fetch(`http://${address}/api/v1/local-models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models: Model[] = await res.json();

    const prev = peerStatus.get(address);
    peerStatus.set(address, 'up');

    if (prev !== 'up') {
      logger.info(`[monitor] peer up: ${address}`);
      publishPeerEvent({type: 'peer-up', address, models});
    }
  } catch {
    const prev = peerStatus.get(address);
    peerStatus.set(address, 'down');

    if (prev === 'up') {
      logger.info(`[monitor] peer down: ${address}`);
      publishPeerEvent({type: 'peer-down', address});
    }
  }
}

// Guard against a second monitor loop if instrumentation ever re-runs in the
// same process (e.g. across dev-server reloads).
const STARTED_KEY = Symbol.for('turbo-jumbo.peer-monitor-started');

// Poll each remote peer's /api/v1/local-models and publish peer-up/peer-down
// events (fanned out to browsers by /api/v1/events), so the UI tracks
// reachability live.
export function startPeerMonitor(): void {
  const remotePeers = config.peers.filter((p) => p !== localPeer);
  if (remotePeers.length === 0) return;

  const g = globalThis as {[STARTED_KEY]?: boolean};
  if (g[STARTED_KEY]) return;
  g[STARTED_KEY] = true;

  const poll = () => {
    for (const peer of remotePeers) void checkPeer(peer.address);
  };

  poll();
  setInterval(poll, (config.peer_check_interval ?? 5) * 1000);
}
