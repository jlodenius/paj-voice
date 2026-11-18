export interface BackgroundAudioSettings {
  mode: 'off' | 'duck' | 'duck-all';
  gain: number;
  apps: string[];
  excludeApps: string[];
}

export const isFocusMetadataLabel = (value: unknown): value is string => typeof value === 'string'
  && /^[\x20-\x7e]{0,256}$/u.test(value) && !value.includes('://');

export interface FocusAssociatedClient {
  id: number;
  serial: string;
  source: 'node' | 'client';
  appId: string;
  binary: string;
  role: string;
  name: string;
  applicationName: string;
}

export interface FocusStream {
  serial: string;
  id: number;
  appId: string;
  binary: string;
  role: string;
  name: string;
  volumes: number[];
  muted: boolean;
  associatedClient?: FocusAssociatedClient;
}

export interface FocusSnapshot {
  generation: string;
  streams: FocusStream[];
}

export interface FocusGraph {
  snapshot(): Promise<FocusSnapshot>;
  compareAndSet(generation: string, stream: FocusStream, volumes: number[], restore?: boolean,
    allOtherPlayback?: boolean): Promise<boolean>;
}

export interface FocusPreview {
  available?: string[];
  eligible: string[];
  excluded: number;
  unsupported: number;
}
