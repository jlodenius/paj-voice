import type { BackgroundAudioPreferences } from './config.ts';

export type Environment = Record<string, string | undefined>;
export type NotificationLevel = 'info' | 'warning' | 'error';
export type SpeechPriority = 'normal' | 'urgent';

export interface VoiceToken {
  generation: string | null;
  epoch: number;
}

export interface SpeechRequest extends Partial<VoiceToken> {
  text?: string;
  priority?: SpeechPriority;
  purpose?: 'answer' | 'progress' | 'inbox-summary';
  key?: string;
  id?: string;
}

export interface SpeechResult {
  status: 'unavailable' | 'stale' | 'listening' | 'duplicate' | 'queued' | 'silent';
  id?: string;
}

export interface VoiceState extends VoiceToken {
  enabled: boolean;
  starting: boolean;
  eyesFree: boolean;
  sessionId: string | null;
  muted: boolean;
  listening: boolean;
  inputPause?: 'paused' | 'warming' | 'held' | null;
  inputPauseRemainingMs?: number;
  inputAvailable?: boolean;
  outputAvailable?: boolean;
  usingFallback?: boolean;
  speakerMode?: boolean;
  speaking: boolean;
  capturing: boolean;
  processing: boolean;
  reportingOwner: string | null;
  lastError: string | null;
}

export interface Feedback {
  receipt: string;
  steeringReceipt: string;
  progressUpdates: boolean;
  idleReminders: boolean;
}

export interface VoicePreferences {
  voice: string;
  volume: number;
  speed: number;
  pauseSeconds: number;
  maxMessageSeconds: number;
  feedback: Feedback;
  backgroundAudio?: BackgroundAudioPreferences;
}

export interface DeviceSelection {
  speakerMode?: boolean;
  input: string;
  output: string;
  inputDevice?: string;
  outputDevice?: string;
}

export interface Submission {
  sessionId: string | null;
  generation: string | null;
  requestId: string;
  text: string;
}

export interface SubmissionResult {
  status?: string;
  steering?: boolean;
}

export interface VoiceApi {
  version: 1;
  getState(): VoiceState;
  registerReporter(options?: { id?: string; instructions?: string }): () => void;
  speak(request?: SpeechRequest): SpeechResult;
}

export interface PajIdentity {
  id: string;
  role: string;
  pid: number;
  piSessionId: string;
  parentPiSessionId?: string;
  spawnId?: string;
  taskId?: string;
  parentTaskId?: string;
  child?: boolean;
  parentSessionId?: string;
  childTaskId?: string;
}

export interface PajMessageDelivery {
  sessionId: string;
  messageIds: string[];
  requestTurn(): void;
}

export interface PajApi {
  version: number;
  getSnapshot(): { identity?: PajIdentity; editorBusy?: boolean };
  tryReserve(token: string): boolean;
  release(token: string): void;
}

export interface CompanionFrame {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  completed?: unknown;
  input?: unknown;
  output?: unknown;
  fallback?: unknown;
  speakerMode?: unknown;
  listening?: unknown;
  phase?: unknown;
  remainingMs?: unknown;
  playing?: unknown;
  playbackGeneration?: unknown;
  outputEpoch?: unknown;
  stage?: unknown;
  message?: unknown;
  reason?: unknown;
  details?: unknown;
}

export type CompanionCommand =
  | { type: 'stop' | 'shutdown' }
  | { type: 'mute'; muted: boolean }
  | { type: 'input_pause'; id: string; seconds: number }
  | { type: 'speak'; id: string; text: string; priority: SpeechPriority; key?: string }
  | { type: 'configure'; generation: string | null; config: Record<string, unknown> };

export function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
