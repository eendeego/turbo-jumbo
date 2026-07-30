import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020';
import schema from '@/config.schema.json';

export interface Peer {
  name: string;
  address: string; // host:port the peer serves on
  // Required for the local peer; remote peers manage their own paths.
  base_path?: string;
  cold_storage_path?: string;
  // Subdirectory names under base_path; default to turbo-jumbo / lemonade.
  turbo_jumbo_subdir?: string;
  lemonade_subdir?: string;
  // API base URL of the Lemonade server tied to this peer, for browsing and
  // downloading the models only that server can fetch (FLM/NPU).
  lemonade_url?: string;
  // Set by the /api/v1/peers response for the peer that is this machine.
  isLocal?: boolean;
}

export interface Config {
  peers: Peer[];
  log_level?: string;
  peer_check_interval?: number;
}

const validate = new Ajv2020({allErrors: true}).compile<Config>(schema);

/**
 * Validate a parsed config object against config.schema.json. Returns null if
 * valid, or a human-readable summary of every violation otherwise. The schema
 * covers structure and types; the "local peer requires base_path and
 * cold_storage_path" rule depends on which peer matches this machine's IP and
 * is left to the caller.
 */
export function validateRawConfig(raw: unknown): string | null {
  if (validate(raw)) return null;
  return (validate.errors ?? [])
    .map((e) => {
      const where = e.instancePath || '(root)';
      if (e.keyword === 'additionalProperties') {
        return `${where} has unknown property "${e.params.additionalProperty}"`;
      }
      return `${where} ${e.message}`;
    })
    .join('; ');
}

function configPath(): string {
  return process.env.CONFIG_PATH ?? `${process.cwd()}/config.yaml`;
}

function loadConfig(): Config {
  const file = configPath();
  const loaded = yaml.load(fs.readFileSync(file, 'utf8'));
  const error = validateRawConfig(loaded);
  if (error) throw new Error(`Invalid config at ${file}: ${error}`);
  return loaded as Config;
}

// Loaded once when this module is first imported (on server boot).
export const config = loadConfig();

// The host part of "host:port" (also strips IPv6 brackets).
function addressHost(address: string): string {
  return address.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

// The local peer is the one whose address host matches one of this machine's
// own IP addresses. undefined when none match.
export const localPeer: Peer | undefined = (() => {
  const localIps = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((ni): ni is os.NetworkInterfaceInfo => ni != null)
      .map((ni) => ni.address),
  );
  return config.peers.find((p) => localIps.has(addressHost(p.address)));
})();

/**
 * The turbo-jumbo (local models) and Lemonade directories for a peer, derived
 * from its base_path and optional subdir-name overrides. Defaults: models live
 * in <base>/turbo-jumbo and Lemonade's cache in <base>/lemonade.
 */
export function resolveBaseSubdirs(peer: Peer): {
  localModels: string;
  lemonade: string;
} {
  const base = peer.base_path!;
  return {
    localModels: path.join(base, peer.turbo_jumbo_subdir ?? 'turbo-jumbo'),
    lemonade: path.join(base, peer.lemonade_subdir ?? 'lemonade'),
  };
}

// The local peer's model directories. undefined when no local peer matches
// this machine.
export const localModelsDir: string | undefined = localPeer?.base_path
  ? resolveBaseSubdirs(localPeer).localModels
  : undefined;

export const coldStorageDir: string | undefined = localPeer?.cold_storage_path;

// Lemonade keeps its own model cache. The scanner skips it (see
// lib/models/models.ts's scanModels) so Lemonade's copies don't show up as local
// models.
export const lemonadeDir: string | undefined = localPeer?.base_path
  ? resolveBaseSubdirs(localPeer).lemonade
  : undefined;
