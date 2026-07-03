import {readFileSync} from 'node:fs';
import {startPeerMonitor} from '@/lib/peers/peer-monitor';

// Node-runtime side of instrumentation.ts; runs once at server boot.

// Load the HuggingFace token from a mounted secret file, if configured, so the
// `hf` CLI can authenticate without the token living in the environment/image.
const hfTokenFile = process.env.HF_TOKEN_FILE;
if (hfTokenFile) {
  process.env.HF_TOKEN = readFileSync(hfTokenFile, 'utf8').trim();
}

startPeerMonitor();
