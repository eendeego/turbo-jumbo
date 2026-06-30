import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';

// Answer CORS preflight (OPTIONS) requests for the API so cross-peer calls
// from the browser succeed. Actual response headers are set in next.config.ts.
export function proxy(request: NextRequest) {
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
}

export const config = {
  matcher: '/api/:path*',
};
