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
  recover?(text: string): 'saved' | 'full';
  close?(): void;
  uuid?: () => string;
  setTimer?: (callback: () => void, milliseconds: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export function createVoiceController({ submit, send, recover, close, changed = () => {}, notify = () => {}, uuid = randomUUID,
  setTimer = setTimeout, clearTimer = clearTimeout }: ControllerOptions) {
  let sessionId: string | null = null;
  let generation: string | null = null;
  let epoch = 0;
  let enabled = false;
  let ready = false;
  let muted = false;
  let listening = false;
  let inputAvailable = false;
  let inputPause: 'pausing' | 'paused' | 'warming' | 'held' | 'unconfirmed' | null = null;
  let inputPauseAckTimer: Timer | null = null;
  let inputPauseRemainingMs = 0;
  let inputPauseId: string | null = null;
  const pauseRequests = new Map<string, number>();
  const clearInputPauseAck = () => {
    if (inputPauseAckTimer !== null) clearTimer(inputPauseAckTimer);
    inputPauseAckTimer = null;
  };
  const clearInputPause = () => {
    clearInputPauseAck();
    inputPause = null; inputPauseId = null; inputPauseRemainingMs = 0;
  };
  let outputAvailable = false;
  let usingFallback = false;
  let speakerMode = false;
  let speaking = false;
  let captureId: string | null = null;
  let speechId: string | null = null;
  let turnSpoken = false;
  let finalAnswerSpoken = false;
  let fallbackSent = false;
  let summaryExpected = true;
  let pendingUserSummary = false;
  let run = 0;
  let turnSilent = false;
  let inboxEpoch: number | null = null;
  let inboxSummaryEpoch: number | null = null;
  let userOutcomeExpected = false;
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
  const limitedCaptures = new Set<string>();
  let recoveryStopSpeech: string | null = null;
  let recoveryStopTimer: Timer | null = null;
  const clearRecoveryStop = () => {
    if (recoveryStopTimer !== null) clearTimer(recoveryStopTimer);
    recoveryStopTimer = null;
    recoveryStopSpeech = null;
  };
  const reporters = new Map<string, { instructions: string }>();
  const submissions = new Map<string, { status: 'uncertain' | 'submitted' | 'rejected' | 'recovered' | 'cancelled' }>();
  const announcements = new Map<string, string>();
  const state = (): VoiceState => ({ enabled: enabled && ready, starting: enabled && !ready, eyesFree: enabled && ready && outputAvailable,
    sessionId, generation, epoch, muted, listening, inputPause, inputPauseRemainingMs, inputAvailable, outputAvailable, usingFallback, speakerMode, speaking, capturing: !!captureId, processing: running,
    reportingOwner: reporters.keys().next().value ?? null, lastError });
  const idle = () => enabled && ready && inputAvailable && outputAvailable && !muted && !disposed && !running && !blocked && !deliveryUncertain &&
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
    const available = () => feedback.progressUpdates && enabled && ready && outputAvailable && !muted && !disposed && running && agentActive &&
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
  const failInputPause = () => {
    clearInputPauseAck();
    inputPauseId = null;
    inputPause = 'unconfirmed';
    inputPauseRemainingMs = 0;
    listening = false;
    lastError = 'Microphone closure is unconfirmed. Voice is being stopped for privacy; do not assume capture has closed.';
    inform(lastError, 'error');
    try { send({ type: 'shutdown' }); } catch {}
    try { close?.(); } catch {}
    emit();
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
    speak({ text, generation: target, epoch: turn, priority = 'normal', purpose, key, id = uuid() } = {}) {
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
      if (captureId && outputAvailable) { rememberUnplayed('new_speech'); return { status: 'listening' }; }
      if (typeof text !== 'string' || !text.trim() || text.length > 320 ||
          text.trim().split(/\s+/u).length > 50 || /[\u0000-\u001f\u007f]/u.test(text) ||
          !['normal', 'urgent'].includes(priority) || (purpose !== undefined && !['answer', 'progress', 'inbox-summary'].includes(purpose)) || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) ||
          (key !== undefined && (typeof key !== 'string' || !key || key.length > 128))) {
        throw new Error('Speech must be plain text, at most 320 characters / 50 words, with a valid priority/key');
      }
      const previous = announcements.get(id);
      const signature = JSON.stringify([text, priority, purpose, key, target, turn]);
      if (previous) {
        if (previous !== signature) throw new Error('Announcement ID conflict');
        return { status: 'duplicate', id };
      }
      announcements.set(id, signature);
      while (announcements.size > 512) announcements.delete(announcements.keys().next().value!);
      if (!outputAvailable) {
        playback.unplayed({ id, text, generation: target, epoch: turn, key }, 'output_unavailable');
        return unavailable();
      }
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
        if (purpose === 'inbox-summary' && inboxEpoch === epoch) inboxSummaryEpoch = epoch;
        else {
          turnSpoken = true;
          if (purpose === 'answer') finalAnswerSpoken = true;
        }
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
      clearInputPause();
      ready = false;
      listening = false;
      inputAvailable = outputAvailable = false;
      usingFallback = speakerMode = false;
      captureId = null;
      captures.clear();
      limitedCaptures.clear();
      clearRecoveryStop();
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
    pauseInput(seconds: number, token: VoiceToken, id = uuid()) {
      if (token.generation !== generation || token.epoch !== epoch) return { status: 'stale' as const };
      if (!enabled || !ready || muted || disposed || inputPause === 'held' || inputPause === 'unconfirmed') return { status: 'unavailable' as const };
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300 || !/^[\w-]{1,128}$/.test(id)) {
        return { status: 'invalid' as const };
      }
      if (pauseRequests.has(id)) return { status: pauseRequests.get(id) === seconds ? 'duplicate' as const : 'invalid' as const };
      if (pauseRequests.size >= 512) return { status: 'unavailable' as const };
      pauseRequests.set(id, seconds);
      clearInputPauseAck();
      inputPauseId = id;
      inputPause = 'pausing';
      inputPauseRemainingMs = 0;
      inputAvailable = listening = false;
      for (const capture of captures) submissions.set(capture, { status: 'cancelled' });
      captures.clear(); limitedCaptures.clear(); captureId = null;
      activity();
      const target = generation;
      const timer = setTimer(() => {
        if (inputPauseAckTimer !== timer || generation !== target || inputPauseId !== id) return;
        failInputPause();
      }, 3000);
      inputPauseAckTimer = timer;
      timer?.unref?.();
      let accepted = false;
      try { accepted = send({ type: 'input_pause', id, seconds }) !== false; } catch {}
      if (!accepted) {
        failInputPause();
        return { status: 'unavailable' as const };
      }
      emit();
      return { status: 'requested' as const };
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
    turn() { return run; },
    inboxPending() { return inboxEpoch === epoch; },
    inboxSummaryNeeded() { return inboxEpoch === epoch && inboxSummaryEpoch !== epoch; },
    userOutcomePending() { return userOutcomeExpected; },
    canRetryInboxSummary(token: VoiceToken) {
      return token.generation === generation && token.epoch === epoch && inboxEpoch === epoch &&
        inboxSummaryEpoch !== epoch && !userOutcomeExpected && !turnSilent && !captureId &&
        enabled && ready && outputAvailable && !muted && !blocked && running;
    },
    incoming() {
      if (!enabled || !ready || !outputAvailable || muted || disposed) return false;
      statusAnnouncement = true;
      try { api.speak({ text: 'A Paj agent message arrived.', generation, epoch, key: 'paj-arrival' }); }
      finally { statusAnnouncement = false; }
      return true;
    },
    requireInboxSummary(token: VoiceToken) {
      if (token.generation !== generation || token.epoch !== epoch) return;
      inboxEpoch = epoch;
      inboxSummaryEpoch = null;
      summaryExpected = true;
    },
    silenceTurn(token: VoiceToken & { turn: number }) {
      if (token.generation !== generation || token.epoch !== epoch || token.turn !== run || !running) {
        return { status: 'stale' as const };
      }
      if (!enabled || !ready || muted) return { status: 'unavailable' as const };
      turnSilent = true;
      return { status: 'silenced' as const };
    },
    playback() { return playback.snapshot(); },
    start(id: string) {
      if (disposed) throw new Error('Voice interface was closed');
      if (enabled) return state();
      sessionId = id;
      clearInputPause();
      pauseRequests.clear();
      lastError = null;
      lastStopReason = null;
      generation = uuid();
      enabled = true;
      ready = false;
      inputAvailable = outputAvailable = false;
      usingFallback = speakerMode = false;
      muted = false;
      epoch++;
      captureId = null;
      submissions.clear();
      captures.clear();
      limitedCaptures.clear();
      clearRecoveryStop();
      announcements.clear();
      playback.clear();
      turnSpoken = false;
      finalAnswerSpoken = false;
      fallbackSent = false;
      pendingUserSummary = false;
      turnSilent = false;
      inboxEpoch = null;
      inboxSummaryEpoch = null;
      userOutcomeExpected = false;
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
      clearInputPause();
      pendingUserSummary = false;
      ready = false;
      listening = false;
      inputAvailable = outputAvailable = false;
      usingFallback = speakerMode = false;
      muted = false;
      captureId = null;
      captures.clear();
      limitedCaptures.clear();
      clearRecoveryStop();
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
      clearInputPause();
      if (value) usingFallback = speakerMode = false;
      captureId = null;
      captures.clear();
      limitedCaptures.clear();
      clearRecoveryStop();
      listening = !value && ready && inputAvailable;
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
      if (inputPause === 'pausing' || inputPause === 'unconfirmed') { failInputPause(); return; }
      if (inputPause) { inputPause = 'held'; inputPauseRemainingMs = 0; listening = false; }
      activity();
      epoch++;
      turnSpoken = true;
      fallbackSent = true;
      stopSpeech('manual_stop');
      emit();
    },
    answer({ text, generation: target, epoch: turn, purpose }: VoiceToken & {
      text: string; purpose?: 'inbox-summary';
    }): SpeechResult {
      if (target === generation && (turn !== epoch || captureId)) {
        return api.speak({ text, generation: target, epoch: turn, key: 'answer' });
      }
      if (purpose === 'inbox-summary') {
        if (turnSilent || inboxEpoch !== epoch || inboxSummaryEpoch === epoch) return { status: 'silent' };
        return api.speak({ text, generation: target, epoch: turn, key: 'answer', purpose });
      }
      if (!turnSilent && !turnSpoken && !(inboxSummaryEpoch === epoch && !userOutcomeExpected) && (!reporters.size || idleAcknowledgementEpoch === epoch || inboxEpoch === epoch) && text) {
        const result = api.speak({ text, generation: target, epoch: turn, key: 'answer',
          ...(inboxEpoch === epoch && !userOutcomeExpected ? { purpose: 'inbox-summary' as const } : {}) });
        if (result.status === 'queued') {
          finalAnswerSpoken = true;
          idleAcknowledgementEpoch = null;
        }
        return result;
      }
      return { status: 'silent' };
    },
    settled(aborted = false, inboxRetryScheduled = false) {
      const wasRunning = running;
      idleAcknowledgementEpoch = null;
      pendingUserSummary = false;
      running = false;
      agentActive = false;
      activeTools.clear();
      const inboxSatisfied = inboxEpoch === epoch && inboxSummaryEpoch === epoch && !userOutcomeExpected;
      const inboxMissing = inboxEpoch === epoch && inboxSummaryEpoch !== epoch && !userOutcomeExpected;
      if (wasRunning && !turnSilent && !inboxSatisfied && !inboxRetryScheduled && summaryExpected && enabled && ready && outputAvailable && !muted && !blocked && !captureId && !fallbackSent &&
          (!turnSpoken || !finalAnswerSpoken || aborted || inboxMissing)) {
        fallbackSent = true;
        const text = aborted ? 'The agent stopped.' : inboxMissing ? 'An agent update could not be summarized automatically.'
          : turnSpoken ? 'I’m finished for now.'
            : 'I’ve finished this response, but did not produce a spoken summary. Ask me to summarize the result aloud.';
        api.speak({ text, generation, epoch, key: turnSpoken && !inboxMissing ? 'completion' : 'fallback' });
      }
      inboxEpoch = null;
      inboxSummaryEpoch = null;
      userOutcomeExpected = false;
      emit();
    },
    expectSummary({ fromUser = false } = {}) {
      summaryExpected = true;
      pendingUserSummary ||= fromUser;
      if (fromUser) {
        userOutcomeExpected = true;
        turnSilent = false;
        idleDismissed = false;
        idleAcknowledgementEpoch = null;
      }
    },
    newRun({ summaryExpected: expected = true } = {}) {
      deliveryUncertain = false;
      if (!running) {
        run++;
        turnSilent = false;
        userOutcomeExpected = expected || pendingUserSummary;
        summaryExpected = userOutcomeExpected || inboxEpoch === epoch;
        if (summaryExpected) {
          idleDismissed = false;
          idleAcknowledgementEpoch = null;
        }
      }
      else if (expected) { summaryExpected = true; userOutcomeExpected = true; }
      pendingUserSummary = false;
      if (!running) activity();
      agentActive = true;
      if (!running && !captureId) { turnSpoken = false; finalAnswerSpoken = false; fallbackSent = false; }
      running = true;
      emit();
    },
    event(frame: CompanionFrame, target: string | null) {
      if (!enabled || target !== generation || !frame || typeof frame.type !== 'string') return;
      if (frame.type === 'input_pause_state') {
        if (muted || frame.id !== inputPauseId || typeof frame.phase !== 'string' ||
            !['paused', 'warming', 'held', 'resumed'].includes(frame.phase) ||
            typeof frame.remainingMs !== 'number' || !Number.isInteger(frame.remainingMs) ||
            frame.remainingMs < 0 || frame.remainingMs > 300_000) return;
        if (inputPause === 'held' && frame.phase !== 'held') return;
        if (inputPause === 'pausing' && frame.phase === 'resumed') return;
        clearInputPauseAck();
        if (frame.phase === 'resumed') {
          clearInputPause();
          listening = inputAvailable && frame.listening === true;
        } else {
          inputPause = frame.phase as 'paused' | 'warming' | 'held';
          inputPauseRemainingMs = frame.phase === 'paused' ? frame.remainingMs : 0;
          listening = false;
        }
        emit();
        return;
      }
      if (frame.type === 'ready') {
        if (muted) return;
        ready = true;
        inputAvailable = frame.input !== false;
        outputAvailable = frame.output !== false;
        usingFallback = frame.fallback === true;
        speakerMode = frame.speakerMode === true || usingFallback;
        listening = !inputPause && inputAvailable && frame.listening !== false;
        if (usingFallback || !inputAvailable || !outputAvailable) {
          const text = inputAvailable && outputAvailable
            ? 'The preferred route is unavailable. The configured fallback microphone and speakers are active. Recognition pauses during Voice readouts.'
            : `Voice is armed, but ${!inputAvailable ? 'listening' : 'playback'} is suspended while waiting for configured devices. Nothing was replayed.`;
          inform(text, 'warning');
          statusAnnouncement = true;
          try { api.speak({ text, generation, epoch, key: 'availability' }); }
          finally { statusAnnouncement = false; }
        }
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
      if (frame.type === 'availability') {
        if (!ready || muted || typeof frame.input !== 'boolean' || typeof frame.output !== 'boolean') return;
        const fallback = typeof frame.fallback === 'boolean' ? frame.fallback : usingFallback;
        const speakers = typeof frame.speakerMode === 'boolean' ? frame.speakerMode : speakerMode;
        const nextListening = !inputPause && frame.input && (typeof frame.listening === 'boolean' ? frame.listening : listening || !speakerMode);
        if (frame.input === inputAvailable && frame.output === outputAvailable && fallback === usingFallback &&
            speakers === speakerMode && nextListening === listening) return;
        const enteredFallback = fallback && !usingFallback;
        usingFallback = fallback;
        speakerMode = speakers || fallback;
        inputAvailable = frame.input;
        outputAvailable = frame.output;
        listening = nextListening;
        if (!inputAvailable || !listening) {
          for (const id of captures) submissions.set(id, { status: 'cancelled' });
          while (submissions.size > 512) submissions.delete(submissions.keys().next().value!);
          captures.clear();
          limitedCaptures.clear();
          captureId = null;
        }
        if (!outputAvailable) {
          stopSpeech('output_disconnected');
          if (recoveryStopSpeech) return { fatal: true };
        }
        let text = !inputAvailable && !outputAvailable
          ? 'Listening and playback are suspended. Waiting for the selected devices. Unfinished speech was not sent.'
          : !inputAvailable
            ? 'Listening is suspended until the selected microphone returns. Playback remains available. Unfinished speech was not sent.'
            : !outputAvailable
              ? `Playback is suspended. Microphone recognition is ${listening ? 'listening' : 'paused'}. Waiting for the same output; old speech will not replay.`
              : usingFallback
                ? 'The configured fallback microphone and speakers are ready. Recognition pauses during Voice readouts. Old speech was not replayed.'
                : 'The selected microphone and playback are ready again. Old speech was not replayed.';
        if (enteredFallback && (!inputAvailable || !outputAvailable)) text = `Configured fallback selected. ${text}`;
        if (!inputPause) inform(text, inputAvailable && outputAvailable ? 'info' : 'warning');
        if (outputAvailable && !inputPause) {
          statusAnnouncement = true;
          try { api.speak({ text, generation, epoch, key: 'availability' }); }
          finally { statusAnnouncement = false; }
        }
        emit();
        return;
      }
      if (frame.type === 'capture_state') {
        if (!ready || muted || !speakerMode || typeof frame.listening !== 'boolean') return;
        listening = !inputPause && inputAvailable && frame.listening;
        if (!listening) {
          for (const id of captures) submissions.set(id, { status: 'cancelled' });
          while (submissions.size > 512) submissions.delete(submissions.keys().next().value!);
          captures.clear(); limitedCaptures.clear(); captureId = null;
        }
        emit();
        return;
      }
      if (!ready || typeof frame.id !== 'string') return;
      if (inputPause && ['addressed', 'utterance', 'review', 'limit'].includes(frame.type)) return;
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
        if (frame.id === recoveryStopSpeech) {
          clearRecoveryStop();
          return { fatal: true };
        }
        if (ended) emit();
      }
      if (frame.type === 'addressed') {
        if (recoveryStopSpeech) return { fatal: true };
        if (muted || !inputAvailable || !listening || typeof frame.id !== 'string' || !/^[\w-]{1,128}$/.test(frame.id) ||
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
      if (frame.type === 'limit' && !muted && captures.has(frame.id) && !limitedCaptures.has(frame.id)) {
        limitedCaptures.add(frame.id);
        inform('Voice duration limit reached. Stop speaking. The captured portion will be transcribed for manual review, not submitted.', 'warning');
      }
      if (frame.type === 'review' || (frame.type === 'utterance' && limitedCaptures.has(frame.id))) {
        if (muted || !captures.has(frame.id) || typeof frame.text !== 'string' ||
            !frame.text.trim() || frame.text.length > 16384) return;
        captures.delete(frame.id);
        captureId = [...captures].at(-1) ?? null;
        limitedCaptures.delete(frame.id);
        submissions.set(frame.id, { status: 'recovered' });
        while (submissions.size > 512) submissions.delete(submissions.keys().next().value!);
        let saved: 'saved' | 'full' | undefined;
        try { saved = recover?.(frame.text.trim()); } catch {}
        if (!saved) {
          inform('Incomplete voice message was not submitted and transcript recovery failed. Voice stopped.', 'error');
          return { fatal: true };
        }
        inform('Incomplete voice message was not submitted. Its captured portion is saved in memory; use /paj-voice recover to review and complete it before sending.', 'warning');
        const full = saved === 'full';
        if (full) inform('Recovery storage is full. Voice will stop; review saved drafts before rearming.', 'warning');
        statusAnnouncement = true;
        let notice: SpeechResult;
        try {
          notice = api.speak({ text: full
            ? 'Your incomplete message is saved, not sent. Recovery storage is full, so Voice is stopping. Use the voice recover command to review your drafts.'
            : 'Your message reached the time limit and was not sent. Its captured portion is saved for review. Use the voice recover command.',
            generation, epoch, key: 'limit-review' });
        } finally { statusAnnouncement = false; }
        if (full) {
          if (notice.status !== 'queued' || !notice.id) return { fatal: true };
          recoveryStopSpeech = notice.id;
          const target = generation, id = notice.id;
          recoveryStopTimer = setTimer(() => {
            if (generation === target && recoveryStopSpeech === id) close?.();
          }, 30_000);
          recoveryStopTimer?.unref?.();
        }
        emit();
        return;
      }
      if (frame.type === 'cancelled' && captures.delete(frame.id)) {
        if (frame.reason === 'input_disconnected' || frame.reason === 'unreliable_speech') {
          submissions.set(frame.id, { status: 'cancelled' });
          while (submissions.size > 512) submissions.delete(submissions.keys().next().value!);
        }
        limitedCaptures.delete(frame.id);
        captureId = [...captures].at(-1) ?? null;
        if (frame.reason === 'unreliable_speech') inform('Unreliable speech was discarded. Nothing was submitted; please repeat if you intended to speak.', 'warning');
        else if (frame.reason === 'empty') inform('No speech could be transcribed from that capture. Nothing was submitted.', 'warning');
        else if (frame.reason === 'utterance_limit') inform('Voice message exceeded the duration limit and was not submitted.', 'warning');
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
          const result = submit({ requestId: frame.id, text: frame.text.trim(), originalText: frame.text, sessionId, generation });
          record.status = 'submitted';
          running = true;
          turnSilent = false;
          userOutcomeExpected = true;
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
