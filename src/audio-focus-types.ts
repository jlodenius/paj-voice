export interface BackgroundAudioSettings {
  mode: 'off' | 'duck';
  gain: number;
  apps: string[];
  excludeApps: string[];
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
}

export interface FocusSnapshot {
  generation: string;
  streams: FocusStream[];
}

export interface FocusGraph {
  snapshot(): Promise<FocusSnapshot>;
  compareAndSet(generation: string, stream: FocusStream, volumes: number[], restore?: boolean): Promise<boolean>;
}

export interface FocusPreview {
  available?: string[];
  eligible: string[];
  excluded: number;
  unsupported: number;
}
