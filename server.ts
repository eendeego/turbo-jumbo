import {createServer} from 'node:http';
import {parse} from 'node:url';
import next from 'next';
import {initWsServer, handleWsUpgrade, WS_PATH} from './lib/ws-server';
import {startPeerMonitor} from './lib/peer-monitor';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT ?? '3000', 10);

const app = next({dev, port});
const handle = app.getRequestHandler();

await app.prepare();

const upgrade = app.getUpgradeHandler();

const httpServer = createServer((req, res) => {
  handle(req, res, parse(req.url!, true));
});

initWsServer();

// Route WebSocket upgrades ourselves: /ws to our peer-notification server,
// everything else (e.g. Next's dev HMR socket) back to Next. A WebSocketServer
// attached with {server} would otherwise swallow every upgrade and kill HMR.
httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === WS_PATH) {
    handleWsUpgrade(req, socket, head);
  } else {
    upgrade(req, socket, head);
  }
});

startPeerMonitor();

httpServer.listen(port, () => {
  console.log(`> Ready on http://localhost:${port}`);
});
