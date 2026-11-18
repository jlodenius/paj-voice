import { randomUUID } from 'node:crypto';
import { createPlaybackHistory } from './playback.ts';
import { errorCode } from './types.ts';
import type { CompanionCommand, CompanionFrame, Feedback, NotificationLevel,
  SpeechResult, Submission, SubmissionResult, VoiceApi, VoiceState, VoiceToken } from './types.ts';

type Timer = ReturnType<typeof setTimeout>;
interface ControllerOptions {
  submit(params: Submission): SubmissionResult | void;
  send(frame: CompanionCommand): boolean | void;
  changed?(state: VoiceState): void;
  notify?(text: string, level: NotificationLevel): void;
  uuid?: () => string;
  setTimer?: (callback: () => void, milliseconds: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export function createVoiceController({ submit, send, changed = () => {}, notify = () => {}, uuid = randomUUID,
  setTimer = setTimeout, clearTimer = clearTimeout }: ControllerOptions) {
  let sessionId: string | null = null;
  let generation: string | null = null;
  let epoch = 0;
  let enabled = false;
  let ready = false;
  let muted = false;
  let listening = false;
  let speaking = false;
  let captureId: string | null = null;
  let speechId: string | null = null;
  let turnSpoken = false;
  let finalAnswerSpoken = false;
  let fallbackSent = false;
  let summaryExpected = true;
  let pendingUserSummary = false;
  let disposed = false;
  let running = false;
  let lastError: string | null = null;
  let lastStopReason: string | null = null;
  let blocked = false;
  let deliveryUncertain = false;
  let idleTimer: Timer | null = null;
  let idleReminders = 0;
  let idleDismissed = false;
  let idleAcknowledgementEpoch: number | null = null;
  let idleAnnouncement = false;
  let progressTimer: Timer | null = null;
  let statusAnnouncement = false;
  let agentActive = false;
  let feedback: Feedback = { receipt: 'Got it.', steeringReceipt: 'Steering received.',
    progressUpdates: true, idleReminders: true };
  const activeTools = new Map<string, string>();
  const playback = createPlaybackHistory();
  const pendingSpeech = new Set<string>();
  const captures = new Set<string>();
  const reporters = new Map<string, { instructions: string }>();
  const submissions = new Map<string, { status: 'uncertain' | 'submitted' | 'rejected' }>();
  const announcements = new Map<string, string>();
  const state = (): VoiceState => ({ enabled: enabled && ready, starting: enabled && !ready, eyesFree: enabled && ready,
    sessionId, generation, epoch, muted, listening, speaking, capturing: !!captureId, processing: running,
    reportingOwner: reporters.keys().next().value ?? null, lastError });
  const idle = () => enabled && ready && !muted && !disposed && !running && !blocked && !deliveryUncertain &&
    !captureId && !speaking && pendingSpeech.size === 0;
  const clearIdle = () => {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  };
  const clearProgress = () => {
    if (progressTimer !== null) clearTimer(progressTimer);
    progressTimer = null;
  };
  const activity = () => { clearIdle(); clearProgress(); idleReminders = 0; };
  const syncIdle = () => {
    if (!feedback.idleReminders || idleDismissed || !idle() || idleReminders >= 3) { clearIdle(); return; }
    if (idleTimer !== null) return;
    const target = generation, turn = epoch;
    const timer = setTimer(() => {
      if (idleTimer !== timer) return;
      idleTimer = null;
      if (idleDismissed || !idle() || target !== generation || turn !== epoch || idleReminders >= 3) return;
      // Reminder playback must not reset its own three-announcement budget.
      idleAnnouncement = true;
      try {
        const result = api.speak({ text: 'I’m available and have nothing in progress.',
          generation: target, epoch: turn, key: 'idle-reminder' });
        if (result.status === 'queued') idleReminders++;
      } finally { idleAnnouncement = false; }
    }, 60_000);
    idleTimer = timer;
    timer?.unref?.();
  };
  const syncProgress = () => {
    const available = () => feedback.progressUpdates && enabled && ready && !muted && !disposed && running && agentActive &&
      !blocked && !captureId && !speaking && pendingSpeech.size === 0;
    if (!available()) { clearProgress(); return; }
    if (progressTimer !== null) return;
    const target = generation, turn = epoch;
    const timer = setTimer(() => {
      if (progressTimer !== timer) return;
      progressTimer = null;
      if (!available() || target !== generation || turn !== epoch) return;
      const labels: Record<string, string> = { bash: 'Running a command.', read: 'Reading files.',
        edit: 'Updating files.', write: 'Writing files.' };
      const tool = [...activeTools.values()].at(-1);
      const text = tool && Object.hasOwn(labels, tool) ? labels[tool] : 'Still working.';
      statusAnnouncement = true;
      try { api.speak({ text, generation: target, epoch: turn, key: 'progress-status' }); }
      finally { statusAnnouncement = false; }
    }, 60_000);
    progressTimer = timer;
    timer?.unref?.();
  };
  const syncTimers = () => { syncIdle(); syncProgress(); };
  const emit = () => {
    syncTimers();
    if (!disposed) { try { changed(state()); } catch {} }
  };
  const inform = (...args: [string, NotificationLevel]) => { try { notify(...args); } catch {} };
  const stopSpeech = (reason = 'stop') => {
    lastStopReason = reason;
    playback.interrupt(reason);
    send({ type: 'stop' });
    pendingSpeech.clear();
    speechId = null;
    speaking = false;
  };
  const unavailable = (): SpeechResult => ({ status: 'unavailable' });
  const api: VoiceApi = {
    version: 1,
    getState: state,
    registerReporter({ id, instructions } = {}) {
      if (disposed) throw new Error('Voice interface was closed');
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
          typeof instructions !== 'string' || !instructions.trim() || instructions.length > 4096) {
        throw new Error('A bounded reporter ID and instructions are required');
      }
      if (reporters.has(id)) throw new Error('Reporter already registered');
      const entry = { instructions };
      reporters.set(id, entry);
      emit();
      return () => {
        if (disposed) return;
        if (reporters.get(id) !== entry) return;
        reporters.delete(id);
        emit();
      };
    },
    speak({ text, generation: target, epoch: turn, priority = 'normal', key, id = uuid() } = {}) {
      if (!enabled || !ready || muted) return unavailable();
      const rememberUnplayed = (reason: string) => {
        if (target !== generation || announcements.has(id) || typeof text !== 'string' ||
            !text.trim() || text.length > 320 || text.trim().split(/\s+/u).length > 50 ||
            /[\u0000-\u001f\u007f]/u.test(text) || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) ||
            (key !== undefined && (typeof key !== 'string' || !key || key.length > 128))) return;
        playback.unplayed({ id, text, generation: target, epoch: turn, key }, reason);
      };
      if (target !== generation || turn !== epoch) {
        rememberUnplayed(lastStopReason ?? 'stale_epoch');
        return { status: 'stale' };
      }
      if (captureId) { rememberUnplayed('new_speech'); return { status: 'listening' }; }
      if (typeof text !== 'string' || !text.trim() || text.length > 320 ||
          text.trim().split(/\s+/u).length > 50 || /[\u0000-\u001f\u007f]/u.test(text) ||
          !['normal', 'urgent'].includes(priority) || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) ||
          (key !== undefined && (typeof key !== 'string' || !key || key.length > 128))) {
        throw new Error('Speech must be plain text, at most 320 characters / 50 words, with a valid priority/key');
      }
      const previous = announcements.get(id);
      const signature = JSON.stringify([text, priority, key, target, turn]);
      if (previous) {
        if (previous !== signature) throw new Error('Announcement ID conflict');
        return { status: 'duplicate', id };
      }
      announcements.set(id, signature);
      while (announcements.size > 512) announcements.delete(announcements.keys().next().value!);
      if (priority === 'urgent') stopSpeech('priority');
      playback.queued({ id, text, generation: target, epoch: turn, key });
      pendingSpeech.add(id);
      while (pendingSpeech.size > 512) pendingSpeech.delete(pendingSpeech.values().next().value!);
      if (send({ type: 'speak', id, text: text.trim(), priority, ...(key ? { key } : {}) }) === false) {
        pendingSpeech.delete(id);
        playback.ended(id, false, 'transport_unavailable');
        return unavailable();
      }
      if (!idleAnnouncement && !statusAnnouncement) {
        activity();
        turnSpoken = true;
      }
      syncTimers();
      return { status: 'queued', id };
    },
  };
  return {
    api,
    state,
    configureFeedback(value: Partial<Feedback>) {
      if (enabled) throw new Error('Change feedback preferences while voice is off');
      feedback = { ...feedback, ...value };
      activity();
      emit();
    },
    routeChanging() {
      if (!enabled || muted || disposed) throw new Error('Voice must be armed to switch live audio');
      ready = false;
      listening = false;
      captureId = null;
      captures.clear();
      stopSpeech('route_switch');
      activity();
      emit();
    },
    routeNotice(text: string) {
      const previous = statusAnnouncement;
      statusAnnouncement = true;
      try { return api.speak({ text, generation, epoch, key: 'route-notice' }); }
      finally { statusAnnouncement = previous; }
    },
    acknowledgeIdle(token: VoiceToken) {
      if (token.generation !== generation || token.epoch !== epoch) return { status: 'stale' as const };
      if (!enabled || !ready || muted || disposed) return { status: 'unavailable' as const };
      if (idleDismissed) return { status: 'already_acknowledged' as const };
      idleDismissed = true;
      idleAcknowledgementEpoch = epoch;
      clearIdle();
      emit();
      return { status: 'acknowledged' as const };
    },
    instructions() { return reporters.values().next().value?.instructions ?? null; },
    playback() { return playback.snapshot(); },
    start(id: string) {
      if (disposed) throw new Error('Voice interface was closed');
      if (enabled) return state();
      sessionId = id;
      lastError = null;
      lastStopReason = null;
      generation = uuid();
      enabled = true;
      ready = false;
      muted = false;
      epoch++;
      captureId = null;
      submissions.clear();
      captures.clear();
      announcements.clear();
      playback.clear();
      turnSpoken = false;
      finalAnswerSpoken = false;
      fallbackSent = false;
      pendingUserSummary = false;
      idleDismissed = false;
      idleAcknowledgementEpoch = null;
      running = false;
      agentActive = false;
      activeTools.clear();
      blocked = false;
      deliveryUncertain = false;
      activity();
      emit();
      return state();
    },
    stop() {
      if (!enabled && !generation) return;
      enabled = false;
      pendingUserSummary = false;
      ready = false;
      listening = false;
      muted = false;
      captureId = null;
      captures.clear();
      stopSpeech('off');
      playback.clear();
      generation = null;
      sessionId = null;
      epoch++;
      emit();
    },
    dispose() {
      this.stop();
      disposed = true;
      reporters.clear();
    },
    mute(value: boolean) {
      if (!enabled) return;
      muted = value;
      captureId = null;
      captures.clear();
      listening = !value && ready;
      epoch++;
      stopSpeech('mute');
      send({ type: 'mute', muted: value });
      emit();
    },
    toolStarted(id: string, name: string) {
      if (typeof id !== 'string' || id.length > 512 || typeof name !== 'string') return;
      activeTools.set(id, name.slice(0, 64));
      while (activeTools.size > 32) activeTools.delete(activeTools.keys().next().value!);
    },
    toolEnded(id: string) { activeTools.delete(id); },
    blocked(value: boolean) {
      blocked = value;
      activity();
      emit();
    },
    silence() {
      activity();
      epoch++;
      turnSpoken = true;
      fallbackSent = true;
      stopSpeech('manual_stop');
      emit();
    },
    answer({ text, generation: target, epoch: turn }: VoiceToken & { text: string }): SpeechResult {
      if (target === generation && (turn !== epoch || captureId)) {
        return api.speak({ text, generation: target, epoch: turn, key: 'answer' });
      }
      if (!turnSpoken && (!reporters.size || idleAcknowledgementEpoch === epoch) && text) {
        const result = api.speak({ text, generation: target, epoch: turn, key: 'answer' });
        if (result.status === 'queued') {
          finalAnswerSpoken = true;
          idleAcknowledgementEpoch = null;
        }
        return result;
      }
      return { status: 'silent' };
    },
    settled(aborted = false) {
      const wasRunning = running;
      idleAcknowledgementEpoch = null;
      pendingUserSummary = false;
      running = false;
      agentActive = false;
      activeTools.clear();
      if (wasRunning && summaryExpected && enabled && ready && !muted && !blocked && !captureId && !fallbackSent &&
          (!turnSpoken || !finalAnswerSpoken || aborted)) {
        fallbackSent = true;
        const text = aborted ? 'The agent stopped.' : turnSpoken ? 'I’m finished for now.'
          : 'I’ve finished this response, but did not produce a spoken summary. Ask me to summarize the result aloud.';
        api.speak({ text, generation, epoch, key: turnSpoken ? 'completion' : 'fallback' });
      }
      emit();
    },
    expectSummary({ fromUser = false } = {}) {
      summaryExpected = true;
      pendingUserSummary ||= fromUser;
      if (fromUser) {
        idleDismissed = false;
        idleAcknowledgementEpoch = null;
      }
    },
    newRun({ summaryExpected: expected = true } = {}) {
      deliveryUncertain = false;
      if (!running) {
        summaryExpected = expected || pendingUserSummary;
        if (summaryExpected) {
          idleDismissed = false;
          idleAcknowledgementEpoch = null;
        }
      }
      else if (expected) summaryExpected = true;
      pendingUserSummary = false;
      if (!running) activity();
      agentActive = true;
      if (!running && !captureId) { turnSpoken = false; finalAnswerSpoken = false; fallbackSent = false; }
      running = true;
      emit();
    },
    event(frame: CompanionFrame, target: string | null) {
      if (!enabled || target !== generation || !frame || typeof frame.type !== 'string') return;
      if (frame.type === 'ready') {
        ready = true;
        listening = !muted;
        emit();
        return;
      }
      if (frame.type === 'error') {
        const clean = (value: unknown) => typeof value === 'string'
          ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 512) : '';
        lastError = [clean(frame.stage), clean(frame.message)].filter(Boolean).join(': ') || 'Unknown local audio failure';
        inform(`Voice audio failed: ${lastError}. Microphone and playback are being stopped.`, 'error');
        return { fatal: true };
      }
      if (!ready || typeof frame.id !== 'string') return;
      if (frame.type === 'speech_start') {
        if (!pendingSpeech.has(frame.id)) return;
        if (muted || captureId) { stopSpeech(); return; }
        playback.started(frame.id);
        speechId = frame.id;
        speaking = true;
        emit();
      }
      if (frame.type === 'speech_end') {
        const ended = pendingSpeech.delete(frame.id);
        if (ended) playback.ended(frame.id, frame.completed);
        if (frame.id === speechId) {
          speechId = null;
          speaking = false;
        }
        if (ended) emit();
      }
      if (frame.type === 'addressed') {
        if (muted || typeof frame.id !== 'string' || !/^[\w-]{1,128}$/.test(frame.id) ||
            submissions.has(frame.id) || captures.has(frame.id)) return;
        if (captures.size >= 4) return { fatal: true };
        activity();
        captures.add(frame.id);
        captureId = frame.id;
        epoch++;
        stopSpeech('new_speech');
        turnSpoken = true;
        fallbackSent = true;
        emit();
      }
      if (frame.type === 'cancelled' && captures.delete(frame.id)) {
        captureId = [...captures].at(-1) ?? null;
        emit();
      }
      if (frame.type === 'utterance') {
        if (muted || !captures.has(frame.id) || submissions.has(frame.id) ||
            typeof frame.text !== 'string' || !frame.text.trim() || frame.text.length > 16384) return;
        captures.delete(frame.id);
        captureId = [...captures].at(-1) ?? null;
        epoch++;
        const record: { status: 'uncertain' | 'submitted' | 'rejected' } = { status: 'uncertain' };
        submissions.set(frame.id, record);
        while (submissions.size > 512) submissions.delete(submissions.keys().next().value!);
        try {
          const result = submit({ requestId: frame.id, text: frame.text.trim(), sessionId, generation });
          record.status = 'submitted';
          running = true;
          summaryExpected = true;
          idleDismissed = false;
          idleAcknowledgementEpoch = null;
          inform(result?.steering ? 'Voice addition submitted as steering.' : 'Voice request submitted.', 'info');
          api.speak({ text: result?.steering ? feedback.steeringReceipt : feedback.receipt,
            generation, epoch, key: 'receipt' });
          turnSpoken = false;
          finalAnswerSpoken = false;
          fallbackSent = false;
        } catch (error) {
          record.status = errorCode(error) === 'busy' || errorCode(error) === 'editor_busy' || errorCode(error) === 'unavailable'
            ? 'rejected' : 'uncertain';
          if (record.status === 'uncertain') deliveryUncertain = true;
          const text = record.status === 'rejected' ? 'The session cannot accept that request right now.'
            : 'Delivery is uncertain. I will not resend it automatically.';
          inform(text, 'warning');
          api.speak({ text, generation, epoch, key: 'receipt' });
        }
        emit();
      }
    },
  };
}
