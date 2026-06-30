import {createServer} from 'node:http';
import {parse} from 'node:url';
import next from 'next';
import {initWsServer} from './lib/ws-server';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT ?? '3000', 10);

const app = next({dev, port});
const handle = app.getRequestHandler();

await app.prepare();

const httpServer = createServer((req, res) => {
  handle(req, res, parse(req.url!, true));
});

initWsServer(httpServer);

httpServer.listen(port, () => {
  console.log(`> Ready on http://localhost:${port}`);
});
