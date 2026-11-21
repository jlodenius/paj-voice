# paj-voice

`paj-voice` adds voice conversations to an existing
[Pi](https://github.com/earendil-works/pi) session. Speech recognition and playback run locally;
recognized text goes to your configured Pi model. Paj and Captain are optional.

## Install

Requires Linux, Nix, PipeWire, Pi 1.5.2 or newer, and a microphone. Headphones are recommended.
Nix packages the speech models and audio tools; no separate model setup is needed.

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

Install Pi separately. Rebuild NixOS, then run `/reload` in Pi. Install only one copy of the extension.
Without Home Manager, run `nix build`, then `pi install ./result/share/paj-voice`.

## Setup

Add `"voice": {}` to `~/.pi/agent/paj.json`, or to `paj.json` in `PI_CODING_AGENT_DIR` if set.
Keep sibling settings and edit the source of any declaratively managed symlink. For a Voice-only
file override and where device selections are stored, see [Storage](docs/reference.md#storage).

In your main interactive Pi session (not a subagent):

```text
/paj-voice setup desk
```

Setup saves your chosen microphone and output without opening audio. Repeat setup with another name,
such as `headset`, to save another audio selection. Setup asks about speaker protection and keeps
your preferred route unless you explicitly choose otherwise. See
[speaker protection](docs/reference.md#speaker-protection).

Before turning Voice on:

- **Continuous open mic, no wake word:** incidental or misheard speech can become a Pi request
  with the session's normal tool permissions. Existing terminal confirmations remain manual.
- **Audio is processed locally.** Recognized text submitted to Pi goes to the configured model
  provider and is recorded in Pi session history.
- **Wait for closure confirmation.** Bare `/paj-voice pause` and `/paj-voice off` request shutdown
  of all Voice audio. Do not assume the mic is closed until Voice confirms the audio process has
  exited. Setting speech volume to zero does not close the mic.

```text
/paj-voice on
```

Turning Voice on requires confirmation; remain quiet until the ready beep. Then ask a short
question and listen for Pi's reply. If audio is unavailable, check `/paj-voice status`.

## Usage

| Command                         | What it does                                        |
|---------------------------------|-----------------------------------------------------|
| `/paj-voice on`                 | Start Voice, with confirmation.                     |
| `/paj-voice off`                | Close audio; agent work continues.                  |
| `/paj-voice pause` / `resume`   | Pause audio / resume with fresh confirmation.       |
| `/paj-voice pause 10 seconds`   | Pause only the microphone for a bounded duration.   |
| `/paj-voice stop`               | Stop the current spoken reply, not agent work.      |
| `/paj-voice route [name]`       | List saved audio selections or switch to one.       |
| `/paj-voice protection <name>`  | Edit speaker protection while Voice is off.         |
| `/paj-voice status`             | Show current state and settings location.           |
| `/paj-voice devices` / `voices` | List audio devices / installed speaking voices.     |
| `/paj-voice recover`            | Put an overlong dictation in the editor for review. |

`mute` and `unmute` remain aliases for `pause` and `resume`. The panel's `Audio:` row shows the
current selection. You can also ask to switch to a saved selection while Voice is listening.
When Voice is on, compatible [Paj](https://github.com/jlodenius/paj) can deliver incoming agent
updates for [spoken summaries](docs/reference.md#incoming-agent-updates). Paj is not needed for
ordinary voice conversations.
For automatic laptop fallback on headset loss, see [audio recovery](docs/reference.md#audio-recovery).
See [timed microphone pause](docs/reference.md#timed-microphone-pause) for duration and resume rules.

## Options

These settings go inside the shared file's `voice` section. All are optional.
Changes apply the next time you start or resume Voice, not while it is already listening.

| Preference                   | Default                | Available options                       | Meaning                                 |
|------------------------------|------------------------|-----------------------------------------|-----------------------------------------|
| `voice`                      | `"ljspeech"`           | `ljspeech`; other installed voices      | Speaking voice; `/paj-voice voices`.    |
| `volume`                     | `40`                   | Number: `0`–`100`                       | Speech volume, not system volume.       |
| `speed`                      | `1`                    | Number: `0.5`–`2`                       | Speaking speed; `1` is normal.          |
| `pauseSeconds`               | `0.8`                  | Number: `0.3`–`5`                       | Silence before submitting, in seconds.  |
| `maxMessageSeconds`          | `120`                  | Number: `5`–`120`                       | Dictation limit, in seconds.            |
| `feedback.receipt`           | `"Got it."`            | Text: 1–8 words, at most 60 characters  | New request acknowledgement.            |
| `feedback.steeringReceipt`   | `"Steering received."` | Text: 1–8 words, at most 60 characters  | Acknowledgement during active work.     |
| `feedback.progressUpdates`   | `true`                 | `true` / `false`                        | Brief updates during long tasks.        |
| `feedback.idleReminders`     | `true`                 | `true` / `false`                        | Up to three idle reminders.             |
| `backgroundAudio.enabled`    | `false`                | `true` / `false`                        | Lower other playback, calls and alerts. |
| `backgroundAudio.gain`       | `0.2`                  | Number: `0.05`–`1`                      | Multiply each app's existing gain.      |
| `backgroundAudio.ignoreApps` | `[]`                   | List: 0–32 exact app IDs / binary names | Apps never lowered; no wildcards.       |

Dotted names mean nested JSON objects: `feedback.receipt` goes inside `"feedback": { ... }`.
Receipt text cannot contain control characters. The included speaking voice is LJSpeech.
See [all defaults](examples/paj.json) for a complete example.

### Background audio

To lower other playback while Voice speaks, use:

```json
{
  "voice": {
    "backgroundAudio": {
      "enabled": true,
      "gain": 0.2,
      "ignoreApps": []
    }
  }
}
```

Pi Voice itself is always excluded. A gain of `0.2` lowers playback; `1` leaves it unchanged.
To exempt an app, add its exact ID or executable name to `ignoreApps`, such as `[".spotify-wrapped"]`.

Only supported PipeWire playback can be lowered. Music keeps playing; it is not paused. Volume
restoration is best effort: if a warning says audio may remain quiet, adjust the app's volume manually.
`/paj-voice ducking preview` lists eligible apps without changing volume.
`/paj-voice ducking diagnostics` shows read-only current focus status and bounded recent history;
see [diagnostic meanings and limits](docs/reference.md#background-audio-diagnostics).

## What to know

- Headphones allow you to interrupt replies by speaking. With configured speaker-safe audio,
  recognition pauses during replies; wait for LISTENING or use `/paj-voice stop`.
- Bluetooth microphones use headset call mode, which reduces playback quality.
- Dictation over the time limit is held for manual recovery, never submitted as an incomplete command.
- Unreliable recognition is discarded with a warning, not submitted. Repeat your request if needed;
  this is not a guarantee against noise being recognized as speech.

## Reference

- [Audio recovery, storage, upgrading, and development](docs/reference.md)
- [Default settings](examples/paj.json)
