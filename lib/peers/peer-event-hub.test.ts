import {describe, expect, test} from 'bun:test';
import {
  publishPeerEvent,
  subscribePeerEvents,
  peerEventSnapshot,
  resetPeerEventHub,
} from './peer-event-hub';
import type {PeerEvent} from './peer-event-types';

const up = (address: string): PeerEvent => ({
  type: 'peer-up',
  address,
  models: [],
});
const down = (address: string): PeerEvent => ({type: 'peer-down', address});

describe('peer-event-hub', () => {
  test('delivers published events to subscribers', () => {
    resetPeerEventHub();
    const seen: PeerEvent[] = [];
    subscribePeerEvents((e) => seen.push(e));

    publishPeerEvent(up('a:1'));
    publishPeerEvent(down('a:1'));

    expect(seen).toEqual([up('a:1'), down('a:1')]);
  });

  test('unsubscribe stops delivery', () => {
    resetPeerEventHub();
    const seen: PeerEvent[] = [];
    const unsubscribe = subscribePeerEvents((e) => seen.push(e));

    publishPeerEvent(up('a:1'));
    unsubscribe();
    publishPeerEvent(down('a:1'));

    expect(seen).toEqual([up('a:1')]);
  });

  test('snapshot keeps only the latest event per peer', () => {
    resetPeerEventHub();
    publishPeerEvent(up('a:1'));
    publishPeerEvent(up('b:2'));
    publishPeerEvent(down('a:1'));

    expect(
      peerEventSnapshot().sort((x, y) => x.address.localeCompare(y.address)),
    ).toEqual([down('a:1'), up('b:2')]);
  });

  test('a throwing subscriber does not block the others', () => {
    resetPeerEventHub();
    const seen: PeerEvent[] = [];
    subscribePeerEvents(() => {
      throw new Error('dead stream');
    });
    subscribePeerEvents((e) => seen.push(e));

    publishPeerEvent(up('a:1'));

    expect(seen).toEqual([up('a:1')]);
  });
});
