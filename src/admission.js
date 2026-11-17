const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function createAdmission({ pi, getContext, queryPaj, sessionId, generation, env = process.env }) {
  let reservation;
  let reservationApi;
  let reservationRun = false;
  let closed = false;
  let pendingIdle = false;
  let boundPaj;
  let boundPajId;
  const release = () => {
    const token = reservation;
    const api = reservationApi;
    reservation = undefined;
    reservationApi = undefined;
    reservationRun = false;
    try { if (token) api?.release(token); } catch {}
  };
  const context = () => {
    const ctx = getContext();
    if (closed || !ctx || ctx.mode !== 'tui' || !ctx.hasUI ||
        ctx.sessionManager.getSessionId() !== sessionId || env.PAJ_PARENT_PI_SESSION_ID ||
        env.PAJ_SPAWN_ID || env.PAJ_TASK_ID || env.PAJ_PARENT_TASK_ID ||
        (env.PAJ_ROLE && env.PAJ_ROLE !== 'primary')) fail('unavailable', 'Voice needs its original main Pi TUI session');
    return ctx;
  };
  const validate = () => {
    const ctx = context();
    const paj = queryPaj();
    const snapshot = paj?.getSnapshot();
    if (boundPaj && (paj !== boundPaj || snapshot?.identity?.id !== boundPajId)) {
      fail('unavailable', 'The attached Paj identity disappeared or changed');
    }
    if (paj && (paj.version !== 1 || !snapshot?.identity || !snapshot.identity.id || snapshot.identity.role !== 'primary' ||
        snapshot.identity.pid !== process.pid || snapshot.identity.piSessionId !== sessionId ||
        snapshot.identity.parentPiSessionId || snapshot.identity.spawnId || snapshot.identity.taskId ||
        snapshot.identity.parentTaskId || snapshot.identity.child || snapshot.identity.parentSessionId ||
        snapshot.identity.childTaskId)) fail('unavailable', 'Paj identity is not an eligible main session');
    if (paj) { boundPaj = paj; boundPajId = snapshot.identity.id; }
    return { ctx, paj, snapshot };
  };
  return {
    validate,
    submit(params) {
      const { ctx, paj, snapshot } = validate();
      if (params.sessionId !== sessionId || params.generation !== generation) fail('unavailable', 'Voice target changed');
      if (snapshot?.editorBusy) fail('editor_busy', 'An editor request owns this session');
      const steering = !ctx.isIdle();
      if (pendingIdle && !steering) fail('busy', 'A submission has not started');
      if (reservation && (!steering || reservationApi !== paj)) fail('busy', 'A submission has not started');
      let newlyReserved = false;
      if (paj && !reservation) {
        const token = `${generation}:${params.requestId}`;
        if (!paj.tryReserve(token)) fail('editor_busy', 'An external request owns this session');
        reservation = token;
        reservationApi = paj;
        reservationRun = steering;
        newlyReserved = true;
      }
      try {
        if (!steering) pendingIdle = true;
        pi.sendUserMessage(params.text, { expandPromptTemplates: false, ...(steering ? { deliverAs: 'steer' } : {}) });
        return { status: 'submitted', steering };
      } catch (error) {
        pendingIdle = false;
        if (newlyReserved) release();
        throw error;
      }
    },
    started() { pendingIdle = false; if (reservation && !reservationRun) release(); },
    settled() { pendingIdle = false; release(); },
    close() { closed = true; release(); },
  };
}
