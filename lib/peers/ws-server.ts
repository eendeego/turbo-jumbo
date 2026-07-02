import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';
import {WebSocketServer, type WebSocket} from 'ws';
import {logger} from '@/lib/util/logger';

// The path browsers connect to for live peer notifications. server.ts routes
// only this path to us so Next's dev HMR socket keeps working.
export const WS_PATH = '/ws';

let wss: WebSocketServer | null = null;

// Create the WebSocket server in noServer mode; server.ts decides which
// upgrades belong to us (see handleWsUpgrade) versus Next.
export function initWsServer(): void {
  wss = new WebSocketServer({noServer: true});

  wss.on('error', (err: Error) => {
    logger.error(`[ws] server error: ${err.message}`);
  });

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
  logger.trace(
    `[ws] upgrade ${WS_PATH} from ${req.socket.remoteAddress ?? 'unknown'} (upgrade=${req.headers.upgrade ?? '?'}, connection=${req.headers.connection ?? '?'})`,
  );
  if (!wss) return;
  socket.on('error', (err: Error) => {
    logger.error(`[ws] socket error: ${err.message}`);
  });
  try {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss!.emit('connection', ws, req),
    );
  } catch (err) {
    // Bun's built-in ws shim can throw on malformed handshakes instead of
    // cleanly rejecting them (e.g. TypeError in its abortHandshake path).
    // Don't let that take down the upgrade dispatcher — just drop the socket.
    logger.error(`[ws] handleUpgrade threw:`, err as Error);
    socket.destroy();
  }
}

export function getWsServer(): WebSocketServer | null {
  return wss;
}
