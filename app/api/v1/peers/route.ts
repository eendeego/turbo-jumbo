import {NextResponse} from 'next/server';
import {config, localPeer} from '@/lib/config';

// Expose the configured peers to the browser in config-file order, flagging the
// one that is this machine so the UI can show it as "— local".
export function GET() {
  const peers = config.peers.map((p) => ({...p, isLocal: p === localPeer}));
  return NextResponse.json({
    peers,
    interval: config.peer_check_interval ?? 5,
  });
}
