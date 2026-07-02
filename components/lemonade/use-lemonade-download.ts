import {useState} from 'react';
import {
  useDownloadRunner,
  type DownloadRequest,
} from '@/components/hf-download/download-runner';
import type {DownloadTarget} from '@/lib/hf/download-target';
import {
  collectionDownloadPlan,
  matchVariantFiles,
  missingVariantFiles,
  planRepoJobs,
  resolveCheckpointFiles,
  type Checkpoint,
  type InventoryLocation,
  type LemonadeModel,
} from '@/lib/lemonade/lemonade';
import {
  uniq,
  type HfFile,
  type Selection,
} from '@/lib/lemonade/lemonade-catalog';

/**
 * The Lemonade download flow: resolve a selection's files (one repo for a GGUF
 * model, or every checkpoint across an omni collection / component) into HF
 * download requests and run them through the shared runner, sequentially for a
 * multi-repo plan. Owns the resolve/terminal state; the destination (`target`,
 * with `targetName` naming the location its files land in) and the
 * post-download refresh are passed in.
 */
export function useLemonadeDownload({
  target,
  targetName,
  inventoryLocations,
  sendToCold,
  deleteAfterTransfer,
  onDownloaded,
}: {
  target: DownloadTarget;
  targetName: string | null;
  inventoryLocations: InventoryLocation[];
  sendToCold: boolean;
  deleteAfterTransfer: boolean;
  onDownloaded?: () => void;
}) {
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [downloadTitle, setDownloadTitle] = useState('');
  const {term, progress, running, command, start, startMany, cancel, reset} =
    useDownloadRunner(target.displayPath, target.url);

  // A single GGUF model: resolve the variant's files in its one repo and run
  // the downloader once. Unchanged from the original single-model path.
  const startModel = async (model: LemonadeModel) => {
    if (resolving || running) return;
    setResolving(true);
    setResolveError(null);
    try {
      const params = new URLSearchParams({
        repoId: model.repoId,
        branch: 'main',
        recursive: 'true',
      });
      const res = await fetch(`/api/v1/hf-files?${params}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const files = (await res.json()) as HfFile[];
      const all = matchVariantFiles(files, model.variant, model.mmproj);
      if (all.length === 0) {
        setResolveError(
          `No files in ${model.repoId} match "${model.variant ?? 'any gguf'}".`,
        );
        return;
      }
      const targetModels =
        inventoryLocations.find((l) => l.name === targetName)?.models ?? [];
      const missing = missingVariantFiles(all, targetModels, model.repoId);
      setDownloadTitle(model.name);
      setShowTerminal(true);
      void start({
        repoId: model.repoId,
        branch: 'main',
        filePaths: missing.length > 0 ? missing : all,
        sendToCold,
        deleteAfterTransfer,
      });
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  };

  // A collection or one of its components: resolve every checkpoint into a
  // per-repo download request, then run them in sequence through the runner.
  const startPlan = async (checkpoints: Checkpoint[], title: string) => {
    if (resolving || running) return;
    setResolving(true);
    setResolveError(null);
    try {
      const targetModels =
        inventoryLocations.find((l) => l.name === targetName)?.models ?? [];
      const reqs: DownloadRequest[] = [];
      const unresolved: string[] = [];
      for (const job of planRepoJobs(checkpoints)) {
        const params = new URLSearchParams({
          repoId: job.repoId,
          branch: 'main',
          recursive: 'true',
        });
        const res = await fetch(`/api/v1/hf-files?${params}`);
        if (!res.ok)
          throw new Error(`${job.repoId}: ${res.status} ${res.statusText}`);
        const files = (await res.json()) as HfFile[];
        const all = uniq(
          job.variants.flatMap((v) => resolveCheckpointFiles(files, v)),
        );
        // A checkpoint resolving to nothing means the catalog named a file the
        // repo doesn't have (a renamed/moved file). Don't skip it silently — a
        // half-downloaded multi-repo model (e.g. Flux without its VAE) can't run.
        if (all.length === 0) {
          unresolved.push(`${job.repoId} (${job.variants.join(', ')})`);
          continue;
        }
        const missing = missingVariantFiles(all, targetModels, job.repoId);
        reqs.push({
          repoId: job.repoId,
          branch: 'main',
          filePaths: missing.length > 0 ? missing : all,
          sendToCold,
          deleteAfterTransfer,
        });
      }
      if (unresolved.length > 0) {
        setResolveError(
          `Couldn't find the catalog files for ${title} in: ${unresolved.join('; ')}.`,
        );
        return;
      }
      if (reqs.length === 0) {
        setResolveError(`Found no files to download for ${title}.`);
        return;
      }
      setDownloadTitle(title);
      setShowTerminal(true);
      await startMany(reqs, (i, req) =>
        setDownloadTitle(`${title} — ${req.repoId} (${i + 1}/${reqs.length})`),
      );
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  };

  const onDownload = (selection: Selection | null) => {
    if (!selection) return;
    if (selection.kind === 'model') return void startModel(selection.model);
    if (selection.kind === 'standalone' || selection.kind === 'component')
      return void startPlan(
        selection.component.checkpoints,
        selection.component.name,
      );
    return void startPlan(
      collectionDownloadPlan(selection.collection),
      selection.collection.name,
    );
  };

  // Closing the terminal returns to the catalog; the selection stays. Refresh
  // local models so the status markers reflect whatever just landed (a finished
  // download, or partial files from a cancelled one).
  const closeTerminal = () => {
    if (running) cancel();
    setShowTerminal(false);
    reset();
    onDownloaded?.();
  };

  return {
    resolving,
    resolveError,
    showTerminal,
    downloadTitle,
    term,
    progress,
    running,
    command,
    onDownload,
    closeTerminal,
  };
}
