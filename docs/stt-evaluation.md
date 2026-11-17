# Speech recognition evaluation

This is the current next step. It bypasses classification, confirmation, TTS, and agent dispatch.
It does not implement voice pause commands: "Stop listening for five minutes" is only a test phrase.
Ctrl-C is the reliable stop control.

## Run at home

```sh
cd /home/jacob/Development/paj-voice
./scripts/stt-eval run --quick
```

To retry only one phrase, without repeating the whole sequence:

```sh
./scripts/stt-eval run --phrase yes --replay
```

The quick version covers silence, yes, no, of course, and the Nix-agent status question. Allow about
one to two minutes, including your time reading and starting each window. The full version adds
an ordinary request, a qualified yes, partner conversation, and a future voice-pause phrase:

```sh
./scripts/stt-eval run
```

For each phrase:

1. Read the displayed sentence. Say those words naturally rather than paraphrasing for this test.
2. Press Enter to consent to that individual recording window.
3. After the two-second warning, remain quiet during input warm-up. Wait for `SPEAK NOW`, then
   speak once and remain quiet. For the silence prompt, stay quiet throughout.
4. The microphone closes after the seven-second recording window. Warm-up may add up to five
   seconds before that window, so the maximum microphone-open period is twelve seconds. Leave
   silence after the phrase so endpoint detectors finish; late speech is marked unfinished.
5. Only after capture has stopped, the tool transcribes the same RAM recording three ways and
   prints the results. The next microphone window cannot open until you press Enter again.

You can stop at any time with Ctrl-C. Keep WoW running if you want to observe compute times under
normal game load. There are no agent commands, audio-setting changes, or background listeners.

### Input readiness before recording

Speech recording now waits for three consecutive quarter-second windows with no near-full-scale
samples, absolute mean offset at most 0.01 of full scale, and no VAD-detected speech. It keeps the
same capture stream open while waiting: reopening at readiness would risk another startup event.
Warm-up samples are discarded and cannot enter the raw recording or either segmenter's pre-roll.
The printed warm-up summary reports discarded duration, clipped samples, and maximum bucket offset.
If readiness briefly changes before recording starts, the gate resumes waiting within the same
five-second limit rather than aborting or starting prematurely. DC checks use the quarter-second
window budget consistently, including a partial final frame. If input does not settle within five
seconds, the test closes capture without asking you to speak.

After `SPEAK NOW`, the gate does not trim speech or silently discard newly clipped samples; those
remain visible in the recording diagnostics. This mitigates the observed startup corruption, not
its underlying driver/hardware cause or the separate background noise. It changes no gain settings.
The implementation is currently in this evaluation, not the production voice addon.

For future continuously open listening, readiness belongs at enable/re-enable, not before each
utterance. Keeping capture open avoids repeated startup transitions, but still needs ongoing health
monitoring. A genuine microphone-off pause must check readiness again when capture resumes.

### Optional: hear exactly what was captured

With the Sony headphones connected:

```sh
./scripts/stt-eval run --quick --replay
```

Each recording is replayed directly from RAM after the microphone closes, before recognition.
This helps distinguish clearly audible speech being misrecognized from clipping or noisy capture.
Replay never occurs while the microphone is open. There is no output-device selection or playback
unless you request `--replay`; capture-only evaluation does not need the headphones connected.

The launcher selects the known internal laptop microphone, not the Bluetooth microphone. Override
exact node names if needed without changing system defaults:

```sh
PAJ_VOICE_LAB_INPUT='exact.internal.source' \
PAJ_VOICE_LAB_OUTPUT='exact.headphone.sink' ./scripts/stt-eval run --quick --replay
```

## Investigate noise and clipping without Whisper

```sh
./scripts/stt-eval levels
```

This uses two separately approved seven-second silent windows. Keep the room/game setup unchanged
and do not adjust input volume between them. This mode deliberately bypasses readiness filtering
so the original startup defect remains observable. It does not load Whisper, run recognition, or
write recordings. The tiny VAD still runs, but the output contains numeric diagnostics only.

For each window it prints read-only source state/volume metadata before and after capture, followed
by 0.25-second peak, RMS, signed mean, and clipped-sample percentage. This distinguishes clipping
concentrated near startup from clipping spread throughout the recording. A large signed mean can
indicate DC offset; these measurements alone do not identify the cause. Gain is never adjusted.

## What is compared

| Path         | Audio sent to the same Whisper recognizer                                 |
| ------------ | ------------------------------------------------------------------------- |
| `full`       | The complete recorded window, without VAD cropping.                       |
| `lab`        | The existing lab segmenter: up to one-second pre-roll, 0.8-second tail.   |
| `production` | The actual production `Turns.feed`: one-second pre-roll, 1.2-second tail. |

All three paths reuse the same captured PCM and recorded VAD decisions. There are no spelling
hints, initial prompts, gain changes, or rerecordings between paths. Input is 16 kHz mono S16.
Whisper stays at `base.en`, CPU/int8, two threads, beam one, and no prior-text conditioning.
No replacement models are downloaded for this first diagnostic step.

Segmentation is replayed with a deterministic sample clock. The production ASR worker, partial
prefix recognition, addressing checks, classifier, playback, and agent admission are deliberately
not run. This isolates final audio-window effects rather than measuring the complete old system.

The first full-window decode can include cold inference overhead. Compute durations exclude capture,
endpoint waiting, replay, and agent work; they are not live end-to-end or barge-in latency.

## Reading the output

Each phrase shows:

- Raw capture duration, peak/RMS, clipped samples, and VAD-positive frame count.
- Every recognized segment, its duration, decode compute time, and unfinished-segment status.
- Normalized exact matches and word-edit counts against the displayed reference.
- A warning flag if a qualified reply such as "Yes, but do not send it" becomes an isolated "Yes".

Scores ignore case/punctuation and expand "what's" and "don't". They do not silently equate "Nix"
with "next", or "Best" with "yes". Word scores are diagnostics, not automatic judgments of meaning.
Multiple segments can matter even when their joined text matches, especially for qualified replies.

For a red/green regression exit code against the lab path, optionally add `--require-exact`:

```sh
./scripts/stt-eval run --quick --require-exact
```

This exits nonzero if a lab result is not normalized-exact, is unfinished, or splits out yes from a
qualified reply. Passing five examples is not a reliability qualification.

Interpret differences carefully:

- Full-window correct, gated wrong: investigate gating, boundaries, and decoder window sensitivity.
- Full-window speech but no gated segment: investigate VAD/threshold decisions.
- All paths wrong, with clipping/noisy replay: investigate the capture path before blaming Whisper.
- All paths wrong despite a clear recording: compare a stronger local recognizer next.

Different text from different windows is not proof of physical cropping alone; context length can
also change Whisper output. Do not fix a failure by adding unsafe affirmative aliases.

## Privacy, bounds, and packaging

Audio remains in RAM for one phrase's paired comparisons and optional replay, then is released.
The program creates no audio files or transcript reports and makes no provider calls. Transcripts,
including incidental speech during a window, appear in terminal scrollback. Do not redirect output
if you do not want transcript files. Only share output that you have reviewed for private content.

Each window has an independent watchdog; audio closes before replay or recognition starts. Capture
queues, recording bytes, segment counts, and recognition calls are bounded. The entire evaluation
allows at most 36 decode calls. A failure stops the evaluation rather than switching devices or
starting another recording automatically.

`nix/stt-eval.nix` provides a separate minimal Python runtime and the already pinned Whisper model.
It does not load classifier or Piper weights. VAD's model is bundled in its Nix runtime dependency.
Nothing is installed into a system/user profile, and runtime model downloads are disabled.
Project caches and the build root live under this checkout; Nix's store remains the shared store.

For a no-microphone preflight:

```sh
./scripts/stt-eval check
```

The preparatory automated tests validate routing, byte-for-byte replay, scoring, bounds, and
cleanup. They do not establish your real speech accuracy; that is what the home evaluation tests.
