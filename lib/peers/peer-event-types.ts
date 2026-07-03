import type {Model} from '@/lib/models/model-types';

// Events the peer monitor publishes to connected browsers over the
// /api/v1/events SSE stream.
export type PeerEvent =
  | {type: 'peer-up'; address: string; models: Model[]}
  | {type: 'peer-down'; address: string};
