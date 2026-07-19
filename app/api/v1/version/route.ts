import {appVersion} from '@/lib/version/app-version';

// A parameterless GET would be statically optimized at build time, freezing
// the builder's answer into the bundle; the version must reflect the running
// server (its env stamps, its checkout).
export const dynamic = 'force-dynamic';

// The running app's version identity: package version, whether this build is
// an official tagged release (dev: false) or carries changes past it, and the
// commit when known. Peers can compare answers to spot version mismatches.
export async function GET() {
  return Response.json(appVersion());
}
