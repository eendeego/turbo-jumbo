import {createServer} from 'node:http';
import {parse} from 'node:url';
import {readFileSync} from 'node:fs';
import next from 'next';
import {initWsServer, handleWsUpgrade, WS_PATH} from './lib/peers/ws-server';
import {startPeerMonitor} from './lib/peers/peer-monitor';

// Load the HuggingFace token from a mounted secret file, if configured, so the
// `hf` CLI can authenticate without the token living in the environment/image.
const hfTokenFile = process.env.HF_TOKEN_FILE;
if (hfTokenFile) {
  process.env.HF_TOKEN = readFileSync(hfTokenFile, 'utf8').trim();
}

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
