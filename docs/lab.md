# Wake-free voice test lab

This experimental lab has **no Pi connection or agent dispatch implementation**. A successful
admission prints `would_send` and plays a short tone; nothing executes. Production voice admission
and your active settings are unchanged. Do not use this as an unattended assistant yet.

## Project-contained environment

Dependencies and all three primary local models are packaged with Nix: Whisper `base.en`, Piper's
English LJSpeech voice, and GLiClass-edge. The speech-activity model is included in the pinned VAD
runtime dependency. Revisions, asset hashes, and licensing provenance are in
`models/lab-gliclass-manifest.json`. Models are fetched at build time, not during inference.
The original GLiNER2 comparison remains reproducible with `models/lab-manifest.json`; each bundle
selects one classifier, not both.

The Piper weight redistribution license is not independently established; this bundle is for local
qualification, not an assertion that the voice can be redistributed freely.

Nix keeps these dependencies in `/nix/store`, not your system or user package profile. The default
closure is approximately 4.1 GB, including about 0.35 GB of primary models. Python caches are
project-local under `.cache`; `result` roots the built package so garbage collection does not remove
it. The ordinary Nix store/download cache and a temporary user-runtime audio lock are not global
installs. Existing models under `~/.local/share/paj-voice/models` are untouched and are not runtime
dependencies of this lab. No pip, npm, model service, or system service installation is required.

Run from this checkout:

```sh
cd /home/jacob/Development/paj-voice
./scripts/voice-lab check
./scripts/voice-lab self-test
```

`check` loads all packaged models without inspecting or opening audio devices. `self-test` generates
repeatable zero-noise synthetic speech in RAM, transcribes it, exercises the classifier, and checks
affirmative versus
negative confirmation using real local STT. Its prompt-drain event is simulated; it is not an
acoustic, microphone, or latency qualification. Neither command opens the microphone or headphones.

For development, use the project shell instead of installing Python dependencies globally:

```sh
nix-shell
python -P -m paj_voice_audio.lab --help
python -m unittest discover -s audio/tests -v
```

The launcher rebuilds the package snapshot when source changes; otherwise it reuses the Nix store
result. The packaged entry point is `./result/bin/paj-voice-lab`. It does not enable listening by
default: a mode is required, and live mode requires explicit device names.

## Current qualification result

Model loading, deterministic state tests, and mocked live orchestration tests pass. The speech
probe is not fully passing: synthetic "of course" and negative rejection work, but a synthetic
"yes" was misheard as "Best" and discarded. The first classifier setup is
**not a useful addressee gate yet**: all 24 held-out text examples were uncertain, and one
development game-chat example was falsely accepted. Expect frequent questions in
real-classification mode.
Do not lower thresholds to hide this result or connect the lab to agent dispatch. Tonight's first
test should qualify the interaction and microphone path, not assume the classifier is reliable.

Both default-noise and repeatable zero-noise synthetic probes included "yes" being misheard as
"Best"; "Nix agent" also became "next agent". An earlier default-noise probe recognized yes
correctly.
The unrecognized confirmation was safely discarded, but this is an STT usability failure.
`self-test` currently reports this failure rather than retrying until green. These Piper samples
are not evidence of how your actual pronunciation will perform.
Use `--show-accepted-text` to inspect the held transcription after confirming it locally.

The smaller GLiClass comparison was faster, about 37 ms warm median versus 365 ms, but all 48 reused
fixtures were uncertain. It also failed to demonstrate useful discrimination. The lab defaults to
this lighter model only for testing the interaction, **not** because it passed the addressee task.
Both reports retain their frozen thresholds; no further models or threshold-tuning loop is planned.

## Tonight: test confirmation first

Wear the Sony headphones and keep the laptop microphone available. The test uses the built-in
microphone, not the Sony microphone. It does not adjust microphone gain, global volume, default
devices, Bluetooth profiles, AEC modules, or other running audio.

```sh
cd /home/jacob/Development/paj-voice
./scripts/voice-lab confirm
```

This explicitly opens the microphone after a three-second warning. Wait for `READY`. Capture ends
automatically after 90 seconds; Ctrl-C stops it sooner. No microphone was opened while preparing it.

The demo speaks a harmless placeholder so you can test interruption. Speech activity provisionally
aborts that owned playback stream without waiting for STT. Rejected speech can resume the demo,
rewound by up to one second to avoid skipping downstream-buffered words. Accepted speech discards
old playback. Output and capture always target exact node names and current serials; device loss
stops the trial instead of falling back to another device.

In `confirm` mode, the initial candidate is **forced uncertain**, regardless of classifier scores.
This tests interaction and STT, not model accuracy:

1. Say a complete request, without any wake word: "What is the status of the Nix agent?"
2. Wait for the local spoken question: "Was that message for me?"
3. After the question finishes, start with "of course", which worked in the synthetic probe.
   "yes" and "that was for you" are also supported exact confirmations, but STT is unqualified.
4. Expect a tone and `would_send`. The held original message is admitted once, never the word yes.
5. Repeat with an unrelated reply, "no", or silence. Expect discard, not a replacement request.
6. Also try speaking during the confirmation question. That overlapping utterance must not count as
   a confirmation; wait for a quiet gap and the completed question before trying a fresh reply.

There are six seconds to **start** a confirmation reply. A timely onset receives separate bounded
capture/recognition time. An unrecognized or qualified answer such as "yes, but do not send it"
discards the held candidate. There is no recursive confirmation of that answer.

The microphone trial limits each continuous utterance to approximately 12 seconds and waits for
0.8 seconds of silence before recognition. Long speech is discarded through its physical endpoint.
Do not start a second request while the previous one is still being recognized. A prompt, model,
queue, timeout, or device failure invalidates pending work. Playback questions are owned and cannot
be interrupted or mistaken for a reply by the logical admission state machine.

The terminal prints decisions and compute durations, not rejected transcripts. Accepted text is
also hidden unless you explicitly add `--show-accepted-text`. The lab writes no audio or transcript
files. Opting into terminal text display can leave accepted text in terminal scrollback or in any
output file you choose to redirect; no erasure of your terminal is promised.

## Then test real classification

```sh
./scripts/voice-lab live
```

This uses actual classifier decisions: accept, reject, or ask for local confirmation. Active agent
metadata is a synthetic `nix` name supplied to the model; this lab does not inspect your real
agents.
Try intended requests, partner conversation, quoted commands, game chat, and ambiguous phrases.
No model score is a guarantee of intent. A phrase about an agent can still be addressed to a person.
The GLiClass default is the lighter interaction-test option, not a validated automatic filter.
For reproducing the original GLiNER2 experiment, select it explicitly:

```sh
PAJ_VOICE_LAB_CLASSIFIER=gliner2 ./scripts/voice-lab check
```

For a no-microphone classifier trial, use an authored phrase:

```sh
./scripts/voice-lab text 'What is the status of the Nix agent?'
```

Typed confirmation requires an interactive terminal. Noninteractive or piped stdin cannot
approve a held message, avoiding an unbounded wait for a partial line.

For different devices, supply exact names without changing system defaults:

```sh
PAJ_VOICE_LAB_INPUT='exact.source.name' \
PAJ_VOICE_LAB_OUTPUT='exact.headphone.sink.name' ./scripts/voice-lab confirm
```

The launcher binds the previously identified laptop/Sony node names by default. They must still
exist; there is no automatic reconnect or alternative-device selection. List exact names without
opening the microphone using:

```sh
nix-shell --run 'python -P -m paj_voice_audio --devices'
```

A nearby person's unrelated "yes" can also be ambiguous during confirmation. This protocol is not
speaker authentication; the first trial remains disconnected from all real agent actions.

## Interpreting evidence

See `research/addressing-benchmark.md` and `research/addressing-gliclass-benchmark.md`, with their
JSON reports, for the authored text comparisons. The second model reused the same fixture splits,
so these are not independent household evaluation results. Unit and synthetic tests are not
household qualification. Measure false accepts, missed requests,
clarification frequency, and performance while the game is running.

A reported `playback_abort_completed` duration measures the process-level abort call only, **not**
time from physical speech onset to acoustic silence. Bluetooth buffering and speech detection add
delay. The previous 6.069-second barge-in result belongs to the old prefix-recognition design, not a
measurement of this lab. No acoustic latency has been qualified for this implementation.

Semantic classification does not solve echo cancellation. The direct built-in-mic/headphones path
is experimental, and playback leakage can still cause unwanted pauses or questions. The first
live trial is specifically intended to reveal such problems without dispatching anything.
