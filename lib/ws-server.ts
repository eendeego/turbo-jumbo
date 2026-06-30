import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {WebSocketServer, type WebSocket} from 'ws';
import {logger} from './logger';

// The path browsers connect to for live peer notifications. server.ts routes
// only this path to us so Next's dev HMR socket keeps working.
export const WS_PATH = '/ws';

let wss: WebSocketServer | null = null;

// Create the WebSocket server in noServer mode; server.ts decides which
// upgrades belong to us (see handleWsUpgrade) versus Next.
export function initWsServer(): void {
  wss = new WebSocketServer({noServer: true});

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const addr = req.socket.remoteAddress ?? 'unknown';
    logger.info(`[ws] peer connected: ${addr}`);

    ws.on('close', () => {
      logger.info(`[ws] peer disconnected: ${addr}`);
    });

    ws.on('error', (err: Error) => {
      logger.error(`[ws] error (${addr}):`, err.message);
    });
  });
}

// Complete a /ws upgrade handshake and surface it as a 'connection' event.
export function handleWsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  if (!wss) return;
  wss.handleUpgrade(req, socket, head, (ws) =>
    wss!.emit('connection', ws, req),
  );
}

export function getWsServer(): WebSocketServer | null {
  return wss;
}
