# Continuous speech and interruption test

This is a new commands-disabled test, not the classifier-based lab and not a working Pi agent.
There is **no wake word, classifier, confirmation question, or agent connection**. Every detected
utterance is treated as speech for this local test. It never dispatches commands or cancels work.

## Start explicitly

Connect the Sony headphones and use the laptop microphone:

```sh
cd /home/jacob/Development/paj-voice
./scripts/voice-lab continuous --show-text
```

The equivalent direct command is `./scripts/continuous-test run --show-text`.
It requires an interactive terminal and Enter consent before playback or microphone capture.
`--show-text` explicitly displays all recognized speech in terminal scrollback; omit it to hide
transcripts. Review private content before sharing output. The program writes no audio or transcript
files, but terminal logging or manual output redirection may retain displayed text.

The microphone stays open for at most 90 seconds, including warm-up, then closes automatically.
Ctrl-C stops it sooner. Voice-controlled mute/pause is **not implemented**; spoken stop commands
are merely transcribed. Use the manual stop or timer for privacy.

## What to do

1. The local voice explains the test while the microphone is still closed.
2. Capture opens once and discards warm-up audio until the existing input-readiness check passes.
   Remain quiet until the beep and `READY`. Readiness has a five-second limit.
3. Speak naturally, without Paj: "What is the status of the Nix agent?"
4. After endpointing and transcription, expect this fixed response:
   "Request heard. This is a test; nothing was executed. You can interrupt this response with
   another request."
5. While that response plays, say something different: "Actually, focus on the failing tests."
6. Listen for whether playback stops promptly and inspect whether the complete new utterance is
   transcribed. The old reply is discarded, not resumed. The new utterance gets the same fixed
   reply.
7. Try another ordinary request. There are no reference sentences or automatic word-accuracy scores;
   compare the displayed transcript with what you intended.

The microphone does not reopen between utterances, playback, or recognition. Warm-up happens once.
There are no microphone-gain changes, default-device changes, AEC modules, or Bluetooth profile
switches. Input and output are pinned to their exact names and current serials, with no fallback.
A Bluetooth microphone is rejected; the headset remains a playback device.

## What the implementation measures

Speech activity aborts owned playback before waiting for Whisper. A single local CPU recognizer
then decodes endpointed utterances. New speech invalidates an old reply immediately; an older
recognition result remains visible with `superseded: true` but cannot start stale playback.
Thus an addition spoken while the prior turn is decoding is not silently discarded as stale text.

`interruption_processed` reports a process-level duration and whether playback was active. It does
**not** measure physical speech onset to acoustic silence. VAD delay, capture buffering and
Bluetooth output buffering remain outside that number. Report what you actually hear as well as the logs.

There is a small text-reference echo guard for the fixed spoken phrases. Matching transcripts are
marked `possibleEcho` and do not trigger another response, but are still displayed with
`--show-text`. This is not AEC, speaker identification, or addressee detection. A user quoting the
response can also match it. Partial/mixed echo can escape it, and echo can still cause an unwanted playback pause.
Those are limitations to observe, not claims that headphone leakage is solved.

## Bounds and failures

The test stops after 90 seconds or 20 recognized turns, whichever comes first. Each utterance has
a twelve-second cap; longer speech is discarded through its endpoint. Recognition has a ten-second
latency limit. Capture/event/recognition queues are bounded; overflow stops rather than silently
losing requests. Device loss or audio/inference failure closes owned resources instead of choosing
another device. Late results cannot restart playback after shutdown.

All speech is assumed intended while armed. Do not use this as an unattended room listener or
connect it to real agents. This trial only tests recognition, the continuous capture lifecycle,
local feedback, and interruption mechanics. There is no accuracy or latency qualification yet.

## Diagnose a warm-up timeout

A timeout alone does not identify its cause. Run one local-only readiness check:

```sh
./scripts/voice-lab continuous --warmup-only
```

Press Enter to consent and remain quiet until `MICROPHONE CLOSED`; this check does not play a
listening beep. It closes as soon as readiness passes or the five-second readiness deadline fails,
with an independent six-second capture watchdog. No transcription, replay or agent connection runs.

The printed report contains only numeric/boolean input diagnostics, not recorded audio or speech
text. Quarter-second buckets show clipping, absolute DC mean, VAD speech flags and consecutive
stable time. Rejection counters can overlap. `discardedSeconds` versus elapsed wall time helps
identify delayed PCM startup, while `armRetries` and partial-bucket statistics expose transient
readiness loss. A VAD speech flag is not proof that a human spoke; noise can also trigger it.

Ordinary continuous and agent trials now print the same diagnostics on a readiness timeout, before
cleanup clears partial state. Thresholds, the five-second readiness deadline and microphone gain
are unchanged. Diagnostic tests are not a reproduction or fix of a particular live input failure.

## Project-contained package

`nix/continuous.nix` packages CPU-only Whisper, Piper, VAD, and their dependencies. It reuses the
existing pinned speech assets and packages **no classifier weights or classifier dependencies**.
Runtime downloads and telemetry are disabled. Nothing is added to system or user package profiles.
The Piper licensing/provenance caveat in the lab documentation still applies to this local test.
Caches and the build root remain in the project; dependencies reside in the shared Nix store.

A preflight that loads speech models and synthesizes a fixed phrase in RAM, without opening any
microphone or playback device:

```sh
./scripts/continuous-test check
```

The preparatory tests use fake devices and fake inference. They verify one continuous capture,
interruption, preservation of both utterances, stale-reply suppression, classifier isolation, and
cleanup. They do not prove physical barge-in speed or your real speech accuracy.
