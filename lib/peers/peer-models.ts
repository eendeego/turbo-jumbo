import type {AsyncState} from '@/lib/util/async-state';
import type {Model} from '@/lib/models/model-types';

/**
 * A peer's models as the browser holds them: loading, loaded, or failed. The
 * table, the inventory and the peer poller all pass these around, so the type
 * lives here rather than in any one of them.
 */
export type PeerModels = AsyncState<Model[]>;
