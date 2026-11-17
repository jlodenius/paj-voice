import { randomUUID } from 'node:crypto';
import { createTrialServer } from './agent-trial-server.js';

const entryType = 'paj-voice-readonly-trial-v1';
const policy = 'Read-only voice conversation trial: ALL model tool calls are blocked, including reading files, bash, edits, delegation and nested tools. Answer using conversation context only; do not claim to have checked live state or executed requests. Your final answer will be spoken locally. Use plain text, one short sentence, at most 320 characters and 50 words; no Markdown, URLs or code. Include important uncertainty. New speech stops audio, not your processing; treat subsequent voice messages as additions or corrections.';

import { spokenAnswer } from './speech-text.js';
export { spokenAnswer } from './speech-text.js';

export function registerAgentTrial(pi, { allowedSessionId, projectRoot, env = process.env,
  makeServer = createTrialServer } = {}) {
  if (!allowedSessionId || !projectRoot) throw new Error('An explicit session pin and project are required');
  let ctx, guard, bridge, reservation, reservationApi, runGeneration;
  let preparing = false;
  let lifetime = 0;
  const submitted = new Map();
  const nonce = randomUUID();
  const id = current => current?.sessionManager.getSessionId();
  const notify = (text, level = 'info') => { try { ctx?.ui.notify(text, level); } catch {} };
  const status = () => { try { ctx?.ui.setStatus('voice-trial', guard ?
    `Voice trial: ${bridge ? 'prepared / read-only' : 'off / TOOLS BLOCKED'}` : undefined); } catch {} };
  const queryPaj = () => {
    let api;
    pi.events.emit('paj:external:v1', { reply(value) { api = value; } });
    return api;
  };
  const validate = () => {
    if (id(ctx) !== allowedSessionId || ctx.mode !== 'tui' || !ctx.hasUI || env.PAJ_SPAWN_ID ||
        env.PAJ_TASK_ID || env.PAJ_PARENT_PI_SESSION_ID || env.PAJ_PARENT_TASK_ID ||
        (env.PAJ_ROLE && env.PAJ_ROLE !== 'primary')) throw new Error('This trial is pinned to its original main Pi session');
    const api = queryPaj();
    if (reservationApi) {
      const identity = api?.getSnapshot()?.identity;
      if (api !== reservationApi || identity?.piSessionId !== allowedSessionId || identity.pid !== process.pid ||
          identity.role !== 'primary') throw new Error('The attached Paj identity changed');
    }
    return api;
  };
  const persist = active => pi.appendEntry(entryType,
    { version: 1, sessionId: allowedSessionId, active, tools: guard.tools });
  const releaseReservation = () => {
    const api = reservationApi, token = reservation;
    reservationApi = reservation = undefined;
    try { if (token) api?.release(token); } catch {}
  };
  const stop = (reason = 'Voice capture stopped; model processing was not cancelled.') => {
    lifetime++;
    const previous = bridge;
    bridge = undefined;
    runGeneration = undefined;
    previous?.close();
    releaseReservation();
    submitted.clear();
    status();
    if (previous) notify(`${reason} Tools remain blocked until /voice-trial release.`, 'warning');
  };
  pi.on('session_start', (_event, current) => {
    stop();
    if (guard) pi.setActiveTools(guard.tools);
    guard = undefined;
    ctx = current;
    if (id(current) === allowedSessionId) {
      const entries = current.sessionManager.getBranch();
      const saved = [...entries].reverse().find(entry => entry.type === 'custom' && entry.customType === entryType);
      if (saved?.data?.active) {
        const data = saved.data;
        guard = { tools: Array.isArray(data.tools) && data.tools.every(tool => typeof tool === 'string') ? data.tools : [] };
        pi.setActiveTools([]);
        notify('Recovered the read-only voice guard. Tools remain blocked until /voice-trial release.', 'warning');
      }
    }
    status();
  });
  pi.on('tool_call', () => {
    if (!guard) return;
    if (Number.isInteger(runGeneration)) {
      bridge?.answer(runGeneration, 'This trial blocks all tools. Stop it and release the guard before requesting normal work.');
    }
    return { block: true, terminate: true,
      reason: 'Read-only voice trial: ALL model tools are blocked. End the trial and explicitly release its guard for normal work.' };
  });
  pi.on('before_agent_start', (event, current) => {
    ctx = current;
    if (!guard) {
      delete event.systemPromptOptions.sections.paj_voice_trial;
      return;
    }
    pi.setActiveTools([]);
    if (bridge && (event.messageType !== 'user' || !submitted.has(event.prompt))) {
      stop('Non-voice input took control of this session.');
    }
    event.systemPromptOptions.sections.paj_voice_trial = policy;
  });
  pi.on('context', event => {
    if (!guard) return;
    runGeneration = undefined;
    for (const message of [...event.messages].reverse()) {
      if (message.role !== 'user') continue;
      const text = typeof message.content === 'string' ? message.content :
        message.content?.filter(part => part.type === 'text').map(part => part.text).join('');
      runGeneration = submitted.get(text)?.generation;
      break;
    }
    bridge?.status?.('context', runGeneration ? 'associated' : 'unassociated', runGeneration ?? null);
    return { messages: [...event.messages, { role: 'custom', customType: entryType,
      content: policy, display: false, timestamp: Date.now() }] };
  });
  pi.on('message_end', event => {
    if (!bridge || event.message?.role !== 'assistant' || event.message.stopReason !== 'stop') return;
    if (!runGeneration) {
      bridge.status?.('reply', 'no_association', null);
      return;
    }
    const text = spokenAnswer(event.message);
    bridge.answer(runGeneration, text ?? 'The answer is available on screen.');
  });
  pi.on('input', event => { if (event.source === 'interactive') stop('Typed input stopped voice capture.'); });
  pi.on('model_select', () => stop('Model selection changed; voice capture stopped.'));
  pi.on('session_tree', () => { stop(); if (guard) persist(true); });
  pi.on('session_shutdown', () => { stop(); unsubscribe?.(); });
  const unsubscribe = pi.events.on('paj:external:changed:v1', () => {
    if (!bridge) return;
    try { validate(); } catch { stop('Paj identity was lost.'); }
  });
  pi.registerCommand('voice-trial', {
    description: 'Prepare this pinned session for a bounded voice trial with ALL model tools blocked; off, release, status.',
    async handler(args, current) {
      ctx = current;
      const command = args.trim() || 'status';
      if (command === 'status') {
        notify(`Session ${id(current)}. Voice ${bridge ? 'prepared' : 'off'}; tools ${guard ? 'BLOCKED' : 'normal'}.`);
        return;
      }
      if (command === 'off') { stop(); return; }
      if (command === 'release') {
        if (!guard) { notify('No voice tool guard is active.'); return; }
        stop();
        if (!current.isIdle() || current.hasPendingMessages()) {
          notify('Capture is off. Wait until the agent and queued messages finish before releasing tools.', 'warning'); return;
        }
        if (!await current.ui.confirm('Restore model tools?',
          'The microphone is off. Confirm that the voice conversation has finished. Restoring tools permits normal commands and file changes again.')) return;
        if (!current.isIdle() || current.hasPendingMessages()) { notify('The session became busy; tools remain blocked.', 'warning'); return; }
        persist(false);
        pi.setActiveTools(guard.tools);
        guard = undefined;
        status();
        notify('Voice is off. Original model tools restored.');
        return;
      }
      if (command !== 'prepare') { notify('Use /voice-trial prepare, off, release, or status.', 'warning'); return; }
      if (preparing || bridge) { notify('A trial is already being prepared.', 'warning'); return; }
      preparing = true;
      const activation = ++lifetime;
      try {
        validate();
        if (guard || !current.isIdle() || current.hasPendingMessages()) throw new Error('Use an idle session; release any prior voice guard first');
        if (!await current.ui.confirm('Prepare read-only voice for THIS session?',
          `Session: ${allowedSessionId}. Every recognized request will go to this session's configured model provider and is normally saved in Pi history. STT/TTS stay local. All model tools will be blocked until explicit release. No microphone opens yet.`)) return;
        validate();
        if (activation !== lifetime || !current.isIdle() || current.hasPendingMessages()) throw new Error('Preparation was cancelled or the session became busy');
        const paj = queryPaj();
        if (paj) {
          const identity = paj.getSnapshot()?.identity;
          if (paj.version !== 1 || identity?.piSessionId !== allowedSessionId || identity.pid !== process.pid || identity.role !== 'primary') {
            throw new Error('Paj identity is not the pinned primary session');
          }
          reservationApi = paj;
          reservation = `voice-trial:${nonce}`;
          if (!paj.tryReserve(reservation)) throw new Error('An editor or external request owns this session');
        }
        if (!current.isIdle() || current.hasPendingMessages()) throw new Error('The session became busy');
        guard = { tools: pi.getActiveTools() };
        persist(true);
        pi.setActiveTools([]);
        let created;
        created = await makeServer({ sessionId: allowedSessionId, runtimeDir: env.XDG_RUNTIME_DIR,
          onOnset() { validate(); },
          onUtterance(frame) {
            validate();
            if (!guard || bridge !== created || reservationApi?.getSnapshot()?.editorBusy) throw new Error('Voice admission unavailable');
            const prompt = `[Voice trial ${nonce} #${frame.sequence}]\n${frame.text}`;
            submitted.set(prompt, { generation: frame.generation });
            pi.sendUserMessage(prompt, { expandPromptTemplates: false, deliverAs: 'steer' });
          },
          onClose(reason) { if (bridge && bridge === created) stop(reason); },
        });
        if (activation !== lifetime || id(ctx) !== allowedSessionId) {
          created.close();
          throw new Error('Preparation was cancelled');
        }
        bridge = created;
        status();
        notify(`Prepared, no microphone opened. Run in another terminal:\ncd ${projectRoot}\n./scripts/voice-lab agent --agent-socket ${bridge.socketPath} --session ${allowedSessionId} --show-text\nCtrl-C there or /voice-trial off here stops capture. Tools stay blocked until /voice-trial release.`);
      } catch (error) {
        stop();
        status();
        notify(`Voice trial unavailable: ${error.message}${guard ? ' Tools remain blocked; use /voice-trial release when idle.' : ''}`, 'error');
      } finally { preparing = false; }
    },
  });
  return { stop };
}
