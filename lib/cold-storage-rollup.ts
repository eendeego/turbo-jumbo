// The model-level cold-storage rollup, shared by every place that aggregates a
// model's quants into one status. It lived inline in three spots (the server
// table builder and two client recomputes) and drifted — one copy kept counting
// only weights — so a present-but-not-cold mmproj slipped through on some tabs.
// One definition keeps them in lockstep.

/** The per-quant fields the rollup needs; a subset of the table's QuantInfo. */
export interface RollupQuant {
  coldComplete: boolean; // a size-matching cold copy exists
  inColdStorage: boolean; // a cold file of this name exists (size aside)
  isProjector?: boolean; // a companion mmproj, not a weight
}

/**
 * Aggregate a model's quants into its cold-storage status. Complete only when
 * every file — weights AND any companion mmproj projector — has a matching cold
 * copy, so a projector present locally or on a peer but absent from cold storage
 * drops the model to Partial. None-in-cold (the Missing state) is keyed off the
 * weights alone: a weightless group can't be "complete", and a lone projector
 * shouldn't read as a present model.
 */
export function coldStorageRollup(quants: RollupQuant[]): {
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
} {
  const weights = quants.filter((q) => !q.isProjector);
  return {
    allInColdStorage: weights.length > 0 && quants.every((q) => q.coldComplete),
    noneInColdStorage:
      weights.length === 0 || weights.every((q) => !q.inColdStorage),
  };
}
