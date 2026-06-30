import type {Server} from 'node:http';
import type {IncomingMessage} from 'node:http';
import {WebSocketServer, type WebSocket} from 'ws';
import {logger} from './logger';

let wss: WebSocketServer | null = null;

// Attach a WebSocket server to the custom HTTP server so peers can push
// filesystem-change notifications to connected browsers.
export function initWsServer(httpServer: Server): void {
  wss = new WebSocketServer({server: httpServer});

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

export function getWsServer(): WebSocketServer | null {
  return wss;
}
