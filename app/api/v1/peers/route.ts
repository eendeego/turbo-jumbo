import {NextResponse} from 'next/server';
import {config, localPeer} from '@/lib/config';

// Expose the configured peers to the browser, flagging the one that is this
// machine and listing it first so the UI can show it as "— local".
export function GET() {
  const peers = config.peers.map((p) => ({...p, isLocal: p === localPeer}));
  peers.sort((a, b) => Number(b.isLocal) - Number(a.isLocal));
  return NextResponse.json(peers);
}
