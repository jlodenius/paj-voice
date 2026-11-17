import { createServer } from 'node:net';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export async function createTrialServer({ sessionId, runtimeDir, onOnset, onUtterance, onClose }) {
  if (typeof runtimeDir !== 'string' || !isAbsolute(runtimeDir)) throw new Error('An absolute XDG_RUNTIME_DIR is required');
  const stat = await lstat(runtimeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('A private, owned XDG_RUNTIME_DIR is required');
  }
  const directory = await mkdtemp(join(runtimeDir, 'paj-voice-trial-'));
  await chmod(directory, 0o700);
  const socketPath = join(directory, 'agent.sock');
  let peer, used = false, closed = false, hello = false, armed = false;
  let generation = 0, sequence = 0, buffer = '';
  const answered = new Set();
  let timer;
  const send = frame => {
    if (closed || !peer || peer.destroyed) return false;
    const line = JSON.stringify(frame) + '\n';
    if (peer.writableLength + Buffer.byteLength(line) > 16384) { close('Output overflow'); return false; }
    peer.write(line);
    return true;
  };
  const server = createServer(socket => {
    if (used || closed) { socket.destroy(); return; }
    used = true;
    peer = socket;
    socket.setEncoding('utf8');
    socket.on('error', () => close('Client connection failed; delivery may be uncertain'));
    socket.on('close', () => close('Client disconnected'));
    socket.on('data', chunk => {
      if (closed) return;
      buffer += chunk;
      try {
        let newline;
        while (!closed && (newline = buffer.indexOf('\n')) >= 0) {
          if (Buffer.byteLength(buffer.slice(0, newline)) > 8192) throw new Error('Frame too large');
          const frame = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid frame');
          if (!hello) {
            if (frame.type !== 'hello' || frame.version !== 1 || frame.sessionId !== sessionId) {
              throw new Error('Wrong session');
            }
            hello = true;
            send({ type: 'hello', version: 1, sessionId });
          } else if (frame.type === 'arm' && !armed) {
            if (!Number.isInteger(frame.seconds) || frame.seconds < 15 || frame.seconds > 120) {
              throw new Error('Invalid duration');
            }
            armed = true;
            clearTimeout(timer);
            timer = setTimeout(() => close('Bounded agent trial expired'), (frame.seconds + 10) * 1000);
            timer.unref();
            send({ type: 'armed' });
          } else if (frame.type === 'onset' && armed) {
            if (frame.generation !== generation + 1 || frame.generation > 1000) throw new Error('Invalid onset');
            generation = frame.generation;
            onOnset(generation);
          } else if (frame.type === 'utterance' && armed) {
            if (frame.sequence !== sequence + 1 || frame.sequence > 20 ||
                !Number.isInteger(frame.generation) || frame.generation < 1 || frame.generation > generation ||
                typeof frame.text !== 'string' || !frame.text.trim() || frame.text.length > 4096 ||
                /[\u0000-\u001f\u007f]/u.test(frame.text)) throw new Error('Invalid utterance');
            sequence = frame.sequence;
            onUtterance({ sequence, generation: frame.generation, text: frame.text.trim() });
            send({ type: 'accepted', sequence });
          } else throw new Error('Unexpected frame');
        }
        if (Buffer.byteLength(buffer) > 8192) throw new Error('Frame too large');
      } catch {
        close('Protocol/admission failure; nothing will be retried automatically');
      }
    });
  });
  function close(reason = 'Agent trial stopped') {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    buffer = '';
    peer?.destroy();
    server.close(() => { void rm(directory, { recursive: true, force: true }).catch(() => {}); });
    onClose?.(reason);
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    server.on('error', () => close('Agent socket failed'));
    timer = setTimeout(() => close('Preparation expired before the trial started'), 120000);
    timer.unref();
  } catch (error) {
    close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const report = (stage, reason, target = null) => {
    if (armed) send({ type: 'reply_status', stage, reason, generation: target });
  };
  return {
    socketPath,
    status: report,
    answer(target, text) {
      if (!armed || closed) return false;
      if (answered.has(target) || target !== generation) {
        report('bridge', answered.has(target) ? 'duplicate' : 'stale', target);
        return false;
      }
      if (typeof text !== 'string' || !text || text.length > 320 ||
          text.split(/\s+/u).length > 50 || /[\u0000-\u001f\u007f]/u.test(text)) {
        report('bridge', 'invalid_text', target);
        return false;
      }
      const sent = send({ type: 'answer', generation: target, text });
      if (sent) {
        answered.add(target);
        report('bridge', 'sent', target);
      }
      return sent;
    },
    close,
  };
}
