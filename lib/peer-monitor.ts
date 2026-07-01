import {WebSocket} from 'ws';
import {config, localPeer} from './config';
import type {Model} from './models';
import {getWsServer} from './ws-server';
import type {WsMessage} from './ws-messages';
import {logger} from './logger';

const peerStatus = new Map<string, 'up' | 'down'>();
const peerModelsCache = new Map<string, Model[]>();

function sendMsg(ws: WebSocket, msg: WsMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg: WsMessage): void {
  const wss = getWsServer();
  if (!wss) return;
  for (const client of wss.clients) sendMsg(client, msg);
}

async function checkPeer(address: string): Promise<void> {
  try {
    const res = await fetch(`http://${address}/api/v1/local-models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models: Model[] = await res.json();

    const prev = peerStatus.get(address);
    peerStatus.set(address, 'up');
    peerModelsCache.set(address, models);

    if (prev !== 'up') {
      logger.info(`[monitor] peer up: ${address}`);
      broadcast({type: 'peer-up', address, models});
    }
  } catch {
    const prev = peerStatus.get(address);
    peerStatus.set(address, 'down');
    peerModelsCache.delete(address);

    if (prev === 'up') {
      logger.info(`[monitor] peer down: ${address}`);
      broadcast({type: 'peer-down', address});
    }
  }
}

// Poll each remote peer's /api/v1/local-models and broadcast peer-up/peer-down
// to connected browsers, so the UI tracks reachability live.
export function startPeerMonitor(): void {
  const remotePeers = config.peers.filter((p) => p !== localPeer);
  if (remotePeers.length === 0) return;

  const wss = getWsServer();
  if (!wss) return;

  // Send the current known state to each newly connected browser client.
  wss.on('connection', (ws) => {
    for (const [address, status] of peerStatus) {
      if (status === 'up') {
        sendMsg(ws, {
          type: 'peer-up',
          address,
          models: peerModelsCache.get(address) ?? [],
        });
      } else {
        sendMsg(ws, {type: 'peer-down', address});
      }
    }
  });

  const poll = () => {
    for (const peer of remotePeers) void checkPeer(peer.address);
  };

  poll();
  setInterval(poll, (config.peer_check_interval ?? 5) * 1000);
}
