'use client';

import {useEffect, useState} from 'react';
import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Spinner} from '@astryxdesign/core/Spinner';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/models';
import {ModelList} from '@/components/models/model-list';

export function PeersSection() {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [peerModels, setPeerModels] = useState<Map<string, Model[]>>(new Map());

  useEffect(() => {
    fetch('/api/v1/peers')
      .then((r) => r.json())
      .then((data: Peer[]) => setPeers(data));
  }, []);

  useEffect(() => {
    if (!peers) return;

    const fetchModels = () => {
      peers.forEach((peer) => {
        fetch(`http://${peer.address}/api/v1/local-models`)
          .then((r) => r.json())
          .then((models: Model[]) => {
            setPeerModels((prev) => new Map(prev).set(peer.address, models));
          })
          .catch(() => {
            setPeerModels((prev) => new Map(prev).set(peer.address, []));
          });
      });
    };

    fetchModels();
    const id = setInterval(fetchModels, 5000);
    return () => clearInterval(id);
  }, [peers]);

  if (!peers || peers.length === 0) return null;

  return (
    <>
      {peers.map((peer) => {
        const models = peerModels.get(peer.address);
        return (
          <Section key={peer.address}>
            <VStack gap={3}>
              <Heading level={2}>{peer.name}</Heading>
              <Text type="supporting">{peer.address}</Text>
              {models === undefined ? (
                <Spinner label="Loading…" />
              ) : (
                <ModelList models={models} />
              )}
            </VStack>
          </Section>
        );
      })}
    </>
  );
}
