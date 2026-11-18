# paj-voice

`paj-voice` adds continuous voice conversation to an existing
[Pi](https://github.com/earendil-works/pi) session. Enable it explicitly, speak normally, and
interrupt spoken replies by talking. Paj and Captain are optional integrations.

Speech in uses local **Whisper base.en**; speech out uses local **Piper LJSpeech** (US English).
Both models are packaged for CPU use. Pi handles the conversation with your configured model.

## Install

Requires Linux, Nix, PipeWire, Pi 1.5.2 or newer, a microphone, and headphones.
Nix is currently the only supported installation method. It packages Python, native speech libraries,
audio tools, and pinned models together, so no separate Python or model setup is needed.

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
/paj-voice setup desk
/paj-voice setup headset
/paj-voice on
```

Setup saves each named route's microphone and output without opening audio. Arming requires
confirmation; remain quiet until the ready beep. Routes are private and machine-local.

Use `/paj-voice route headset` or say “switch to headset” while armed; use `route desk` to switch
back. `/paj-voice route` lists saved routes. Switching pauses listening briefly, not agent work;
wait for the spoken ready notice before continuing. Unavailable routes leave the current route
unchanged where possible; a failed switch tries only
that exact previous route, never another microphone. Say the request before leaving mic range.

Bluetooth microphones require WirePlumber's automatic headset-profile switching. The headset stays
in call mode while its microphone is open, with lower playback quality than music mode.

## Preferences

These are all supported preferences, relative to the shared file's `voice` section.

| Preference                  | Default                 | Meaning / limits                         |
|-----------------------------|-------------------------|------------------------------------------|
| `voice`                     | `"ljspeech"`            | Packaged voice ID; `/paj-voice voices`.   |
| `volume`                    | `40`                    | Speech volume, 0–100; not system volume.  |
| `speed`                     | `1`                     | Speaking speed, 0.5–2; 1 is normal.       |
| `pauseSeconds`              | `0.8`                   | Silence before submitting, 0.3–5 sec.    |
| `maxMessageSeconds`         | `120`                   | One utterance limit, 5–120 sec.          |
| `feedback.receipt`          | `"Got it."`             | New request acknowledgement.             |
| `feedback.steeringReceipt`  | `"Steering received."`  | Addition during active work.             |
| `feedback.progressUpdates`  | `true`                  | Brief updates during long tasks.         |
| `feedback.idleReminders`    | `true`                  | Up to three idle reminders.              |

Receipt phrases allow 1–8 words and at most 60 characters, without control characters. Progress
and idle notices are roughly one minute apart; activity resets idle reminders. Changes apply on
the next off/on.

Messages support up to two minutes of continuous speech. At the limit, stop speaking: the captured
portion is transcribed and kept in memory, never submitted as an incomplete command. Use
`/paj-voice recover` to load it into an empty Pi editor, then review and complete it before sending.
Up to four incomplete transcripts are retained; Voice stops when that recovery buffer fills.
Recovery survives Voice off/mute, but session changes and quitting Pi clear it.

`/paj-voice voices` lists installed choices; the default package includes only LJSpeech. Other
voices must be packaged first; nothing downloads at runtime. Language, compute precision and
engine tuning are internal, not preferences. See [examples/paj.json](examples/paj.json) for all defaults.

With an updated Paj addon, incoming agent messages request concise spoken summaries, including
progress updates. Messages follow Paj's normal delivery queue; raw worker reports are not read aloud.
An explicitly requested silent response suppresses automatic speech for that run, not future inbox
announcements.

## Usage

- `/paj-voice mute` closes audio; `unmute` asks for fresh confirmation.
- `/paj-voice stop` stops speech only; `off` closes audio without cancelling agent work.
- `/paj-voice status`, `devices`, and `voices` inspect state, hardware IDs, and packaged voices.

After arming, device loss suspends unavailable endpoints instead of ending the session. Without a
configured fallback, available endpoints keep working and the same verified devices recover on return.
Input changes cancel unfinished speech; interrupted or unavailable speech is never replayed.

While Voice is off, `/paj-voice fallback setup laptop` selects an explicitly authorized microphone and
output without changing the preferred route. Choose the built-in microphone and speakers for laptop
fallback. `/paj-voice fallback <name>` uses an existing route; `fallback off` disables automatic
fallback. The private `devices.json` stores this optional named-route reference, never system defaults.

If either preferred endpoint fails, both configured fallback endpoints must be verified before the
fallback pair activates. The preferred saved route stays unchanged; the UI shows both routes. Fallback
stays active until an explicit route switch or rearm, rather than bouncing back on headset reconnect.
Speaker mode pauses recognition during Voice readouts and until quiet to reduce self-transcription;
wait for LISTENING before speaking, or use `/paj-voice stop` to interrupt. Speaker-safety flags remain
on saved routes when automatic fallback is disabled. This is not qualified acoustic echo cancellation.
Off, mute and session changes cancel recovery. Unverifiable endpoints remain suspended.

No wake word or classifier: **all recognized speech while armed can use normal agent tools**.
Existing terminal confirmations remain manual. Audio stays local and is not recorded; recognized
text goes to Pi's provider and normally appears in session history. Volume zero does not mute the mic.

## Storage

Preferences use Pi's agent directory (`PI_CODING_AGENT_DIR`); `PAJ_VOICE_CONFIG` overrides the shared
file. Routes live in `~/.config/paj-voice/devices.json` (0600); cache uses `~/.cache/paj-voice`.
Existing device selections are preserved as the `default` route.
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
