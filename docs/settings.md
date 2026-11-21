# Settings

[Back to setup](../README.md).

## Options

These settings go inside the shared file's `voice` section. All are optional.
Changes apply the next time you start or resume Voice, not while it is already listening.

| Preference                   | Default                | Available options                       | Meaning                                 |
| ---------------------------- | ---------------------- | --------------------------------------- | --------------------------------------- |
| `voice`                      | `"ljspeech"`           | `ljspeech`; other installed voices      | Speaking voice; `/paj-voice voices`.    |
| `volume`                     | `40`                   | Number: `0`–`100`                       | Speech volume, not system volume.       |
| `speed`                      | `1`                    | Number: `0.5`–`2`                       | Speaking speed; `1` is normal.          |
| `pauseSeconds`               | `0.8`                  | Number: `0.3`–`5`                       | Silence before submitting, in seconds.  |
| `maxMessageSeconds`          | `120`                  | Number: `5`–`120`                       | Dictation limit, in seconds.            |
| `feedback.receipt`           | `"Got it."`            | Text: 1–8 words, at most 60 characters  | New request acknowledgement.            |
| `feedback.steeringReceipt`   | `"Steering received."` | Text: 1–8 words, at most 60 characters  | Acknowledgement during active work.     |
| `feedback.progressUpdates`   | `true`                 | `true` / `false`                        | Brief updates during long tasks.        |
| `feedback.idleReminders`     | `true`                 | `true` / `false`                        | Up to three idle reminders.             |
| `audioDucking.enabled`       | `false`                | `true` / `false`                        | Lower other playback, calls and alerts. |
| `audioDucking.gain`          | `0.2`                  | Number: `0.05`–`1`                      | Multiply each app's existing gain.      |
| `audioDucking.ignoreApps`    | `[]`                   | List: 0–32 exact app IDs / binary names | Apps never lowered; no wildcards.       |

Dotted names mean nested JSON objects: `feedback.receipt` goes inside `"feedback": { ... }`.
Receipt text cannot contain control characters. The included speaking voice is LJSpeech.
See [all defaults](../examples/paj.json) for a complete example.

### Audio ducking

To lower other playback while Voice speaks, use:

```json
{
  "voice": {
    "audioDucking": {
      "enabled": true,
      "gain": 0.2,
      "ignoreApps": []
    }
  }
}
```

Pi Voice itself is always excluded. A gain of `0.2` lowers playback; `1` leaves it unchanged.
To exempt an app, add its exact ID or executable name to `ignoreApps`, such as
`[".spotify-wrapped"]`.

Only supported PipeWire playback can be lowered. Music keeps playing; it is not paused. Volume
restoration is best effort: if a warning says audio may remain quiet, adjust the app's volume
manually.
`/paj-voice ducking preview` lists eligible apps without changing volume.
`/paj-voice ducking diagnostics` shows read-only current focus status and bounded recent history;
see [diagnostic meanings and limits](troubleshooting.md#background-audio-diagnostics).

## Storage

Shared preferences are read from `~/.pi/agent/paj.json`, or `paj.json` under `PI_CODING_AGENT_DIR`.
`PAJ_VOICE_CONFIG` overrides that file. Preserve sibling addon settings when editing it; if the file
is a declarative symlink, edit its source.

Private device selections live in `~/.config/paj-voice/devices.json`; cache uses
`~/.cache/paj-voice`. `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` override these locations. Device IDs
do not belong in shared preferences. Models and executable paths are package-managed, not user options.
