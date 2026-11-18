# paj-voice

`paj-voice` adds continuous voice conversation to an existing
[Pi](https://github.com/earendil-works/pi) session. Enable it explicitly, speak normally, and
interrupt spoken replies by talking. Paj and Captain are optional integrations.

Speech in uses local **Whisper base.en**; speech out uses local **Piper LJSpeech** (US English).
Both models are packaged for CPU use. Pi handles the conversation with your configured model.

## Install

Requires Linux, Nix, PipeWire, Pi 1.5.2 or newer, a non-Bluetooth microphone, and headphones.
The package includes the audio runtime and speech models; no Python or model setup is needed.

### NixOS

Add the flake input:

```nix
inputs.paj-voice.url = "github:jlodenius/paj-voice";
```

In your Home Manager configuration:

```nix
imports = [inputs.paj-voice.homeManagerModules.default];
programs.paj-voice.enable = true;
```

Install Pi separately. Rebuild NixOS, then `/reload` in Pi. Install only one copy of the extension.
Without Home Manager, run `nix build`, then `pi install ./result/share/paj-voice`.

## Setup

Merge a `voice` section into `~/.pi/agent/paj.json`, preserving other addon sections:

```json
{
  "voice": {}
}
```

Omitted preferences use the defaults below. In your main Pi session:

```text
/paj-voice setup
/paj-voice on
```

Setup selects microphone/headphones without opening audio. Arming requires confirmation; remain
quiet until the ready beep. Device choices are private and machine-local, not stored in Git.

## Preferences

These are all supported preferences, relative to the shared file's `voice` section.

| Preference                  | Default                 | Meaning / limits                         |
|-----------------------------|-------------------------|------------------------------------------|
| `voice`                     | `"ljspeech"`            | Packaged voice ID; `/paj-voice voices`.   |
| `volume`                    | `40`                    | Speech volume, 0–100; not system volume.  |
| `speed`                     | `1`                     | Speaking speed, 0.5–2; 1 is normal.       |
| `pauseSeconds`              | `0.8`                   | Silence before submitting, 0.3–5 sec.    |
| `maxMessageSeconds`         | `20`                    | One utterance limit, 5–30 sec.           |
| `feedback.receipt`          | `"Got it."`             | New request acknowledgement.             |
| `feedback.steeringReceipt`  | `"Steering received."`  | Addition during active work.             |
| `feedback.progressUpdates`  | `true`                  | Brief updates during long tasks.         |
| `feedback.idleReminders`    | `true`                  | Up to three idle reminders.              |

Receipt phrases allow 1–8 words and at most 60 characters, without control characters. Progress
and idle notices are roughly one minute apart; activity resets idle reminders. An overlong
utterance is discarded, not truncated into a command. Changes apply on the next off/on.

`/paj-voice voices` lists installed choices; the default package includes only LJSpeech. Other
voices must be packaged first; nothing downloads at runtime. Language, compute precision and
engine tuning are internal, not preferences. See [examples/paj.json](examples/paj.json) for all defaults.

## Usage

- `/paj-voice mute` closes audio; `unmute` asks for fresh confirmation.
- `/paj-voice stop` stops speech only; `off` closes audio without cancelling agent work.
- `/paj-voice status`, `devices`, and `voices` inspect state, hardware IDs, and packaged voices.

No wake word or classifier: **all recognized speech while armed can use normal agent tools**.
Existing terminal confirmations remain manual. Audio stays local and is not recorded; recognized
text goes to Pi's provider and normally appears in session history. Volume zero does not mute the mic.

## Storage

Preferences use Pi's agent directory (`PI_CODING_AGENT_DIR`); `PAJ_VOICE_CONFIG` overrides the shared
file. Devices live in `~/.config/paj-voice/devices.json` (0600); cache uses `~/.cache/paj-voice`.
`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` override those bases. Executable/model paths are package-owned.

Older `version`, `stt`, `tts`, `audio`, `turn`, language and runtime-path fields are no longer accepted.
Replace the old Voice section with the example and run setup; device IDs belong in local storage.

## Development

Maintained Node/Pi code is TypeScript; Python implements local audio. Generated JavaScript is build
output. `flake.nix` provides the package, Home Manager module and development shell.

```sh
nix develop
npm ci
npm test
npm run typecheck
./scripts/build-addon
```

Tests use fake audio; build preflight loads models and synthesizes in RAM without capture/playback.
Model hashes and notices are in [models/manifest.json](models/manifest.json). Voice-weight licensing
is separate from the code licence; review model notices before redistributing weights.
