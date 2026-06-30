import type {Model} from './models';

// Messages the peer monitor broadcasts to connected browsers over /ws.
export type WsMessage =
  | {type: 'peer-up'; address: string; models: Model[]}
  | {type: 'peer-down'; address: string};
