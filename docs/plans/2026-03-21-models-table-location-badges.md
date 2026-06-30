# Models table location badges

## Goal

Add **Peers** and **Cold Storage** columns to the models table so each model (and
each quantization, when expanded) shows where it exists.

## Approach (Astryx)

- Lift peer state into a shared `usePeerModels` hook
  (`components/peers/use-peer-models.ts`), returning `{peers, peerModels,
handleModelsRefreshed}`. Both the table and the `Peers` section consume it.
- `HomeClient` (`components/home/home-client.tsx`) becomes the client root: it
  calls the hook, seeds the local peer's models from server data, and passes
  `peerModels` to `ModelsTableClient` and `Peers`. `app/page.tsx` stays a server
  component that scans the filesystem and builds `modelsTableData`.
- `getModelsTableData` (server) annotates each quant with `inColdStorage` and
  rolls up `allInColdStorage` / `noneInColdStorage` per model.
- `ModelsTableClient` adds two columns rendered with Astryx `Badge`:
  - **Peers**: one badge per configured peer, coloured when the model/quant is
    present there (blue = local, cyan = remote), neutral when absent.
  - **Cold Storage**: Complete / Partial / Missing at the model level, Yes /
    Missing per quant.
