import type {NextRequest} from 'next/server';
import type {PeerEvent} from '@/lib/peers/peer-event-types';
import {
  peerEventSnapshot,
  subscribePeerEvents,
} from '@/lib/peers/peer-event-hub';

// Server-Sent Events stream of peer-up/peer-down notifications. Replays the
// current peer state on connect, then forwards events published by the peer
// monitor for as long as the browser stays connected.
export const dynamic = 'force-dynamic';

// Comment frames sent while no peer changes state, so idle timeouts along the
// way never sever an otherwise healthy stream.
const KEEPALIVE_MS = 30_000;

export function GET(request: NextRequest): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: PeerEvent) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );

      for (const event of peerEventSnapshot()) send(event);
      const unsubscribe = subscribePeerEvents(send);
      const keepalive = setInterval(
        () => controller.enqueue(encoder.encode(': keepalive\n\n')),
        KEEPALIVE_MS,
      );

      request.signal.addEventListener('abort', () => {
        unsubscribe();
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // Already errored because the client vanished mid-write.
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
