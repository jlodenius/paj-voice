# Resume after travel

Work was paused because the laptop was hot, then explicitly resumed after the user arrived home.
Pending documentation checks, ten targeted STT tests, and the packaged no-microphone preflight now
pass. No real microphone evaluation has been run; it requires the user's per-window consent.

## Current objective

Prepare STT-only evaluation, bypassing the failed classifiers. At home, explicitly capture short
prompted windows in RAM, close the mic, then compare the identical recording through full-window,
lab segmentation, and production segmentation. No agent dispatch, training, or audio files.

## Files prepared

- `audio/paj_voice_audio/stt_eval.py`: bounded recording, clipping/RMS diagnostics, paired decoding,
  word scores, optional RAM replay, per-window consent, watchdog and cleanup.
- `audio/tests/test_stt_eval.py`: ten fake/no-hardware tests for comparison, bounds and cleanup.
- `nix/stt-eval.nix`: minimal STT/VAD runtime and the existing pinned Whisper model; no classifier
  or Piper weights. Project-local package, no profile installs or new recognition models.
- `scripts/stt-eval`: executable launcher, defaults to no-mic check; explicit run mode needed.
- `docs/stt-evaluation.md`, README pointer, and `.gitignore` entry.

No microphone or playback was opened during preparation. The package built and its no-microphone
preflight passed. The ten new tests and full voice suites passed before the final small prompt/UI
refinements. Last edit adds SPEAK NOW only after first PCM is received, avoiding a cue/startup race.
The latest source snapshot has passed those preparatory checks; real speech accuracy is not fixed
or qualified by them.

## When explicitly resumed

1. Documentation now matches SPEAK NOW and the comparison table is padded.
2. Targeted tests and the rebuilt STT package preflight pass without opening audio.
3. Hand the user the at-home command: `./scripts/stt-eval run --quick`.
4. Optional `--replay` hears the RAM recording through explicitly selected headphones after capture
   closes. Transcripts appear in terminal scrollback; no automatic report files or uploads.
5. Do not run live capture on the user's behalf without renewed readiness and consent.

The broader wake-free lab remains experimental: both classifier setups failed useful addressee
separation. Synthetic yes sometimes became Best; of course worked. No unsafe affirmative aliases
or lowered classifier thresholds were introduced. Voice-controlled five-minute pause is future
work; the evaluation only transcribes its example phrase. Ctrl-C remains the reliable stop.

## Preserve other work

Do not alter unrelated `.nixos/modules/sis/*` changes. No commits, system activation, audio defaults,
Bluetooth profile changes, or system/user package-profile installs were performed. Nix Pi now has a
single declared shared paj.json and no compatibility variables; its live configuration was not
activated, and old currently linked backing files remain intact.
