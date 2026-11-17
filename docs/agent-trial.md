# Read-only voice conversation with the selected Pi session

This experimental bridge connects the continuous speech pipeline to one explicitly selected Pi
session. The current temporary hookup is pinned to the existing Nix conversation, not an agent name
or a replaceable "latest" target. It does not activate the production Voice addon.

## Privacy and permissions

Whisper, VAD and Piper stay local. No audio is uploaded or saved. **Recognized requests go to the
selected Pi session's configured model provider and normally persist in Pi conversation history.**
This is different from the earlier entirely local fixed-response trial. Incidental speech can also
be recognized: there is no wake word, addressee classifier or speaker identification.

All model tool calls are blocked during the trial, including reads, shell commands, edits,
delegation, MCP and nested calls. The agent can answer using conversation context only. It cannot
check live project state, read new files, execute changes, or contact other agents. Tool
availability is disabled and a separate runtime veto enforces the restriction even if a tool is
re-enabled.
This is not an operating-system sandbox: trusted Pi extensions and normal Pi history/cache writes
are outside that model-tool restriction.

Stopping capture does **not** cancel the model or silently discard queued requests. Therefore the
tool guard remains latched after disconnect, expiry, failure and reload. Only an explicit manual
release while the session is idle restores its original tool selection.

## Prepare and start

First build/check the current speech package, without opening audio devices:

```sh
cd /home/jacob/Development/paj-voice
./scripts/voice-lab continuous-check
```

The temporary loader at `~/.nixos/modules/pi/extensions/voice-trial.ts` registers the dormant
command.
It uses the existing live local-extension directory, so no system rebuild or activation is needed.
In the selected Pi conversation:

```text
/reload
/voice-trial prepare
```

Preparation requires an idle main TUI session and a manual privacy/permission confirmation.
It blocks tools and creates a private local socket; it does **not** open the microphone or send a
model request. A different session ID is rejected. When Paj is available, preparation also reserves
the session against competing external input and checks its identity before each admission.

Copy the exact terminal command displayed by preparation. Its form is:

```sh
./scripts/voice-lab agent --agent-socket /private/path/agent.sock --session EXACT_ID --show-text
```

Do not substitute another socket or session ID. Preparation expires after two minutes if not used.
There is no reconnection or automatic replay; release the guard and prepare again if necessary.

In the second terminal, press Enter to consent, remain quiet through warm-up, and wait for the
beep and `READY`. The microphone opens once for at most 90 seconds by default. Then:

1. Ask an ordinary question, such as "How many seconds are in a minute?"
2. Listen for a real short answer from this Pi conversation, rendered by local Piper.
3. Speak over it with a different request or correction.
4. Try an addition while the model is processing. Both recognized messages should remain in Pi,
   while an outdated answer must not restart playback.

Responses are deliberately short plain text, capped at 320 characters and 50 words. Only final
public assistant text is eligible for speech, never thinking or raw tool output. Long, formatted,
truncated or otherwise unsuitable answers get a brief "available on screen" notice instead of a
potentially misleading excerpt. A blocked tool attempt gets a short local restriction notice.
Provider reasoning/network delay is additional to local STT and is not qualified by the earlier
fixed-response test. The selected model and thinking preferences are not changed.

## Stop and restore normal work

Ctrl-C in the audio terminal or this Pi command stops capture and playback:

```text
/voice-trial off
```

Voice-controlled mute/stop is not implemented. The recording also expires automatically. Model
processing and queued messages may continue, but tools remain blocked. Wait for the agent to become
idle, then explicitly restore normal operation:

```text
/voice-trial release
```

Release stops capture first, refuses to restore tools while work/messages remain, and asks for
manual confirmation. Spoken messages cannot execute this command. `/voice-trial status` shows
whether capture is prepared and the tool guard is still latched. Reloading stops the bridge but
recovers an active guard from its session metadata rather than silently enabling tools.
Typed conversational input, a session-tree change or model selection change also stops capture.

## Bounds and caveats

The existing warm-up, continuous capture, twelve-second utterance limit, ten-second local inference
limits, bounded queues, exact device pins and fail-closed device handling are preserved. The agent
bridge adds a private owned runtime directory/socket, an exact session handshake, ordered one-shot
submissions and a maximum of twenty accepted requests. Stale replies are rejected at the bridge
and again before and after local synthesis. New speech never calls the agent's abort API.

`agent_accepted` means Pi accepted submission, not that a requested action executed. An uncertain
transport failure is not automatically retried. Older decoded utterances are still submitted when
new speech has begun; their answer eligibility is tracked separately through actual model context.

If replies are silent, ask one short question and stay quiet for fifteen seconds before adding
another. The terminal now traces reply association, bridge rejection/sending, client receipt,
synthesis completion, playback queuing and draining. These records contain stage/generation metadata,
not hidden reasoning or extra transcript text. `stale` or a changed generation means newer detected
speech superseded an answer; `no_association` means the parent could not link it to a voice request.
A drained playback stream is still not proof of acoustic output from the headphones. These
observations distinguish a missing return-path hop from normal suppression of outdated replies;
they do not establish the cause of an earlier silent trial without such a trace.

The text-reference echo guard now includes the last few spoken answers. It is only a heuristic:
quoting an answer can be flagged as possible echo and not forwarded, mixed echo can escape it,
and playback can still stop spuriously. There is no newly qualified AEC. Review the transcripts
and report both missed words and unwanted interruptions. Process-level abort timings still do not
measure physical speech onset to acoustic silence.

Preparation tests use fake devices/inference and a real Pi runtime with an isolated local fake
provider. An adversarially re-enabled canary tool is vetoed without executing. These checks
establish protocol and permission behavior, not real provider latency, live accuracy or acoustic
performance.
