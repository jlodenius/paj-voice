# paj-voice

Local speech interaction with an existing Pi session, using an **explicitly armed continuous open
microphone**. No wake word, addressee classifier, Paj installation or Captain installation is
required. Linux, PipeWire, headphones and Pi 1.5.2 or newer are required.

This first version uses the capture, startup-readiness, Whisper and interruption path tested on the
laptop microphone and Sony headphones. The complete read-only trial produced real spoken answers
and responsive interruption. The tool-capable addon still needs its own live acceptance test; unit
and fake-provider tests do not establish general accuracy, game coexistence or acoustic latency.

## Permission and privacy

**While armed, every recognized utterance is an ordinary user request with the agent's normal tool
permissions, including commands and file changes.** Incidental speech, background dialogue and
recognition errors can therefore become actionable input. Only arm it where this is acceptable.
There is no speaker identification or uncertain-addressee confirmation in this version.

STT, VAD and TTS run locally. No audio is uploaded or saved to recording files, enrolled or used for
training. Recognized requests go to the selected Pi model provider, which may be remote, and
normally persist in Pi session history. Local speech models do not make the conversational Pi model
local.

Arming requires a manual TUI confirmation. Existing terminal/tool confirmation dialogs remain
manual: spoken "yes" cannot approve a blocking UI prompt. Voice does not expand recognized slash
commands, activate itself, grant extra tools, or change the agent's existing permissions.

## Build without activating audio

```sh
./scripts/build-addon
```

This builds `result-addon`, runs the package tests and loads the bundled speech models with a fixed
RAM-only synthesis check. It opens no microphone or playback stream and installs no package profile,
service or login-time listener. Runtime dependencies and pinned models live in the shared Nix store;
project build roots and caches stay in the project.

The package includes the tested CPU Whisper base.en, Piper voice and VAD environment. No classifier
weights or classifier dependencies are included. Runtime model downloads and telemetry are disabled;
Whisper uses two CPU inference threads. ASR and synthesis are serialized to avoid competing local
inference jobs. English is the only supported speech language in this version.

Whisper licensing/provenance and the Piper model card are included with the pinned assets. Piper
code is GPL-licensed; a model card's dataset license is not an independent grant for the voice
weights. The existing local-evaluation licensing caveat remains; this is not a new
weight-redistribution claim.

## Preferences

Voice preferences are ordinary user choices, not engine or hardware configuration. They live in
the `voice` section of the shared `~/.pi/agent/paj.json`. Preserve the other addon sections.
Every preference is optional; this is a complete, valid minimal configuration:

```json
{
  "voice": {}
}
```

The full example is [examples/paj.json](examples/paj.json). Unknown settings are rejected rather
than silently ignored. Changes take effect the next time you explicitly arm voice; off/on is
required, and a package upgrade also requires Pi's `/reload`. Nothing automatically rearms.

### Complete preference reference

Names below are relative to the shared file's `voice` object. These are **all** supported
preferences; there is no hidden advanced-settings object.

| Preference                 | Default                | Accepted values and meaning                              |
| -------------------------- | ---------------------- | -------------------------------------------------------- |
| `voice`                    | `"ljspeech"`           | Installed voice ID; see `/paj-voice voices`.             |
| `volume`                   | `40`                   | Number 0–100: spoken-reply volume, not system volume.    |
| `speed`                    | `1`                    | Number 0.5–2: 1 is normal, 2 is twice as fast.           |
| `pauseSeconds`             | `0.8`                  | Number 0.3–5: silence needed before submitting speech.   |
| `maxMessageSeconds`        | `20`                   | Number 5–30: maximum duration of one spoken message.     |
| `feedback.receipt`         | `"Got it."`            | Nonempty plain text: at most 8 words and 60 characters.  |
| `feedback.steeringReceipt` | `"Steering received."` | Same text limits; used for additions during active work. |
| `feedback.progressUpdates` | `true`                 | Boolean: brief updates during long-running requests.     |
| `feedback.idleReminders`   | `true`                 | Boolean: reminders when this session has no active work. |

All omitted values use their defaults. Values must have the types shown; strings are not numbers.
Receipts cannot contain control characters or line breaks. The two receipt phrases should remain
distinct so you can distinguish a new request from steering. A receipt means submitted, not that an
action succeeded.

Volume zero silences synthesized speech but does not mute the microphone; use `mute` or `off`
for privacy. The startup ready beep is separate from speech volume. Speed and volume change local
synthesis only; system gains and Bluetooth profiles are never changed.

Longer pauses can prevent sentences being split, but delay submission. A message exceeding the
duration limit is discarded through its endpoint rather than submitted as a truncated command.
The limit does not cap how long the microphone can remain armed.

Progress updates are normally 3–8 words, at most about once a minute while work is active. When a
model cannot give a specific update, the addon uses current tool status, never tool arguments or
output. Idle reminders occur after a quiet minute, repeat at minute intervals at most three times,
and reset with new activity. These intervals and the three-reminder safety limit are fixed.
Disabling either preference also instructs the model not to generate that kind of unsolicited
update. Completion outcomes, important questions and blockers remain enabled. Panel colors follow
your active Pi theme; there is no separate Voice color setting.

### Voice models

`/paj-voice voices` lists voices included in the installed package without loading inference models
or opening audio. Set `voice` to an ID from that list. The default package currently includes only
`ljspeech` (US English); the setting does not imply other voices are preinstalled. Unknown IDs fail
before capture opens. A different voice must first be packaged with its configuration and reviewed
license/provenance. Selecting one never downloads anything at runtime.

Recognition is currently the packaged English Whisper base model, using tested CPU settings.
Language, numerical precision, VAD thresholds, engine flags and model filesystem paths are not user
preferences. English is the only supported language. Do not add `stt`, `tts`, `languages`,
`responseLanguage` or raw model paths to `paj.json`.

### Local microphone and headphones

With voice off, run `/paj-voice setup` to choose readable device names. It saves exact PipeWire IDs
**locally**, outside the shared settings and Git:

- `$XDG_CONFIG_HOME/paj-voice/devices.json`, or `~/.config/paj-voice/devices.json`.
- The directory is owner-private (0700) and the file is owner-private (0600).
- The addon maintains this internal file; it is not another user-edited preference schema.
- Setup opens no audio, loads no inference models and never arms the microphone.
- Cancelling or changing sessions discards the selection. Malformed or unsafe local files are
  refused rather than overwritten.
- Missing selection requires setup; there is no automatic device or reconnect fallback.
- Bluetooth microphone capture and capture monitors are rejected. Use headphones; no echo
  canceller, system default, gain or Bluetooth profile is installed or changed.

`/paj-voice devices` lists compatible devices and their inspectable IDs. Device choices are
machine-specific: copying your shared preferences to another machine does not copy these IDs.
Setup never changes `paj.json`, including when it is a declarative Nix-store file.

### Automatic paths and environment

The installed package supplies its own audio executable. Cache storage is
`$XDG_CACHE_HOME/paj-voice`, or `~/.cache/paj-voice`. No audio recordings are written there.
Executable, cache, device IDs and internal protocol versions are not preferences.

| Environment variable  | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `PAJ_VOICE_CONFIG`    | Explicit path to the entire shared preferences file.            |
| `PI_CODING_AGENT_DIR` | Pi agent directory; defaults to `~/.pi/agent`.                  |
| `XDG_CONFIG_HOME`     | Base directory for the private, machine-local device selection. |
| `XDG_CACHE_HOME`      | Base directory for disposable runtime cache storage.            |

XDG base paths must be absolute. Package-owned model-bundle variables are implementation details,
not supported overrides for selecting remote or arbitrary local models.

### Upgrading older preferences

Old `version`, `audio`, `stt`, `tts`, `turn`, language, executable and cache fields are no longer
accepted in the shared Voice section. There are no legacy aliases or silent migrations.

1. Turn voice off, update the package and reload Pi.
2. Run `/paj-voice setup` to save local microphone/headphone choices.
3. Replace only the shared `voice` section with the new example or `{}`.
4. Carry over message timing intentionally: old `turn.silenceMs / 1000` becomes `pauseSeconds`;
   old `turn.maxSeconds` becomes `maxMessageSeconds`. Model paths become packaged voice IDs.
5. Arm voice manually and test a short request.

Moving current device choices to local storage does not rewrite old Git history.

## Extension loading

Load the built package's `extensions/index.ts` through the normal Pi package or extension loader,
not the unpackaged source extension. The executable is resolved relative to the immutable package.
Loading/reloading never arms capture. Load exactly one copy; remove the personal development
loader when switching to a Home Manager-installed copy. The personal loader resolves the build
link to its immutable Nix store path before importing, preventing stale transitive JavaScript;
status prints the loaded build identity.

## Use

In the intended main Pi TUI session:

```text
/paj-voice setup
/paj-voice devices
/paj-voice voices
/paj-voice on
/paj-voice status
/paj-voice mute
/paj-voice unmute
/paj-voice stop
/paj-voice off
```

`on` asks for explicit consent, starts local inference and opens the selected microphone. Remain
quiet through warm-up and wait for the ready beep. Startup clipping/DC and VAD-active warm-up audio
are discarded until three consecutive quiet quarter-second buckets pass. Failure to settle within
five seconds stops audio and reports numeric diagnostics; post-ready speech is not cropped. If
the observed flat saturation/DC fault recurs after readiness, the stream stops rather than feeding
that corrupted frame to recognition; ordinary clipped speech peaks are not silently filtered.

After readiness, speak naturally without Paj/Pie/Pi. Capture stays open across utterances, model
processing and playback until you explicitly stop it. There is no trial timer or twenty-turn cap.
An above-editor **OPEN MIC** indicator remains visible even with a custom footer; it also reports
warming, muted, speaking and agent-processing states.

Speech activity stops owned playback before waiting for recognition. Both an earlier utterance and
an addition spoken during its decoding are preserved. Busy-session additions use Pi steering rather
than automatic agent cancellation. A newer input invalidates old audio and stale response tokens;
this can suppress a delayed answer if you keep talking before it arrives.

The next model context includes up to 16 recent user-facing speech records from this armed session:
not_queued, queued, started, completed or interrupted, with the spoken text and interruption reason. Completion
requires an explicit software playback-drain acknowledgement; it is not proof of acoustic audibility.
Discarded or unconfirmed end events never count as completed. History is RAM-only in the addon and
cleared on off or a new generation; snapshots passed to the model may persist in normal Pi history.
The transcript itself is not rewritten or automatically merged. The model is instructed to recognize
possible sentence continuations and freshly answer the combined intent using relevant unheard
information. It must honor explicit stops and topic changes, not blindly replay speech or rerun tools.
This adds no separate model call and does not weaken immediate audio interruption. Context delivery
is tested offline; whether a model correctly interprets a particular continuation needs live testing.

A theme-colored panel above the editor makes voice mode distinct without replacing your footer or
editor. It uses the theme's yellow (`warning`) for its frame, OPEN MIC badge and warm-up state,
with a muted MIC CLOSED label when paused. It shows current listening,
receiving, working or speaking activity, and the manual mute/off commands. Labels remain meaningful
without color, the panel fits narrow terminals, and it disappears when voice is off. There are no
flashing indicators or UI animations.

Short final public answers are spoken automatically when appropriate. For detailed coding results,
the model uses `voice_speak` for a separate intentional outcome, question or blocker, normally under
30 words and always at most 50 words / 320 characters. Verbose screen replies, hidden reasoning and
raw tool output are not automatically narrated. While armed, the model is instructed to assume the
user cannot see the screen and provide important answers, outcomes, blockers and questions aloud,
including with a reporting integration. Screen access is reserved for genuinely manual steps such
as blocking confirmations or credential entry, with a spoken explanation; voice cannot approve them.
If no spoken outcome is produced, a brief spoken notice invites a summary request instead of
referring the user to the screen. This notice does not itself summarize or verify the result.
By default, new submissions say “Got it.” Busy-session steering additions say “Steering received.”
These phrases are configurable. Both mean submitted, not executed or successfully completed; rejected or
uncertain delivery keeps its explicit warning instead.

Task outcomes should explicitly say when work finishes, fails, stops or needs input. At Pi's actual
settled event, a request with progress speech but no automatic spoken final answer gets a brief
“I’m finished for now” notice. This means this response has ended, not that external work succeeded.
A spoken final answer is not followed by a duplicate completion notice.

Long-running requests get brief spoken progress about once a minute without ongoing sounds. The
model is instructed to give meaningful stage updates, normally 3–8 words. If it cannot speak while
busy, a local timer uses current tool-lifecycle metadata for short reminders such as “Running a
command” or “Reading files,” otherwise “Still working.” It never reads tool arguments or results.
These fallback reminders do not count as a final outcome. They wait during capture, playback or
blocking confirmations, and stop when the agent settles or audio is muted/off. Any intentional
speech postpones the next automatic reminder by another minute after playback ends. No separate
model call is made for the timer; a request awaiting agent startup is not described as active work.

With idle reminders enabled, after a minute idle the addon says “I’m available and have nothing in progress.” It repeats at
one-minute intervals, at most three times per idle stretch. New requests, work or intentional speech
reset the count. The reminder's own playback does not reset it; intervals start after playback ends.
Reminders wait for capture/recognition, queued requests, agent work, pending playback and blocking
confirmations to clear. Uncertain delivery suppresses availability claims. Off, mute, shutdown and
session changes cancel timers. Reminders do not change microphone state or generate model requests.
These notices describe this Pi session, not unrelated agents or external background jobs.

`stop` discards speech only. `mute` closes the audio process completely; `unmute` explicitly
confirms and starts a fresh generation, with new warm-up and no stale playback. `off` closes audio
and releases owned reservations. None of these aborts agent work or changes normal tool permissions.
Voice-controlled mute/off is not implemented; use the manual commands as the privacy controls.

Session change, tree navigation, model selection change, shutdown, device loss, broken pipes or
bounded-queue failure stop capture rather than retargeting or choosing another device. No automatic
rearming or uncertain-delivery replay occurs. Overlong utterances are discarded through their
endpoint, not submitted as truncated commands. Local inference has a ten-second latency watchdog.

## Audio failures

An audio failure closes capture/playback without cancelling agent work. The notification includes
the native failure stage and a bounded, control-character-stripped error message. `/paj-voice status`
retains that `lastError` after audio stops; a new arming attempt clears it. Startup stages distinguish
preferences, cache, devices, models, capture start and warm-up; playback failures preserve the
underlying playback error. Do not loosen the readiness gate or change devices/gains based only on
a generic failure notification. The recorder's creating thread stays alive until owned audio
children have closed: Linux parent-death protection is thread-scoped, so finishing warm-up must not
end that thread while capture is still active.

## Optional addons

Captain integration belongs to **paj-captain**. It can register specialized reporting instructions;
the first registered reporter owns that policy and prevents duplicate generic final-answer
narration. Standalone Pi operation needs neither Paj nor Captain. When Paj is present, admission
honors its editor/external reservations and stops on identity loss rather than silently bypassing
it.

```js
let voice;
pi.events.emit('paj-voice:api:v1', { reply(api) { voice = api; } });
const unregister = voice?.registerReporter({
  id: 'my-addon', instructions: 'Report brief outcomes, questions and blockers.',
});
```

`getState()` reports activation, session/generation, interruption `epoch`, processing and reporting
owner. Subscribe to `paj-voice:state:v1` for updates. `speak({ text, generation, epoch, priority,
key, id })` queues short intentional speech; use the token associated with the work, never retag
stale output. IDs deduplicate within a generation; keys supersede queued updates and urgent speech
stops older playback. Queued/drained software audio is not proof of acoustic delivery.

This trusted in-process interface cannot activate, unmute, retarget or abort Pi. Unregister
reporters when appropriate and clean up subscribers on shutdown. It is not an operating-system
sandbox.

## Nix / Home Manager

The flake exports `homeManagerModules.default`. Its package includes the pinned speech runtime and
models, excluding training, HTTP-server and classifier extras. Importing/enabling the module
installs the extension and companion, not a microphone service. Activation still requires
`/paj-voice on`.

`programs.paj-voice.configFile` supplies the **entire shared** `paj.json`; alternatively `settings`
supplies inner Voice preferences and generates `{ voice = settings; }`. They are exclusive and own
the whole file. When the host already manages combined addon settings, leave both unset (their
defaults) to avoid overwriting sibling sections. Use locked inputs for deployed configurations.

### Packaging additional voices

This is a package-maintainer interface, not another runtime-settings format. The optional
`voiceModels` argument to `nix/package.nix` is an attribute set keyed by installed voice ID. Each
entry supplies `label`, `model`, `config` and `notice`. Model/config/notice values must be Nix-store
assets with tracked dependencies, such as pinned `fetchurl` outputs or packaged files. Raw host
paths and runtime downloads are not accepted. `notice` records the reviewed model provenance and
license information; a dataset notice alone is not a grant to redistribute voice weights.

The package emits its voice catalogue and retains notices alongside the models. The default
LJSpeech voice remains included. At most 31 extra voices are supported, with IDs matching
`[a-z][a-z0-9_-]{0,63}`. Only compatible English Piper voices are supported; the runtime checks
selected model metadata before opening capture. These assets are fetched only during Nix builds.

Home Manager deployment options are `programs.paj-voice.enable` (default false), `package` (the
bundled package), `settings` (inner preferences, default null), and `configFile` (entire shared
file source, default null). Only one module may own the shared file. These are installation
options, separate from the nine user preferences documented above.

## Checks and historical labs

Run `npm test` for JavaScript, protocol and fake-audio tests. Optional real-Pi tests use an isolated
home and local fake provider; they exercise short answers, intentional speech, normal harmless tool
execution, session binding and teardown without touching real microphones or provider accounts.

The [STT evaluation](docs/stt-evaluation.md), [fixed-response continuous
test](docs/continuous-test.md) and [read-only agent trial](docs/agent-trial.md) remain
diagnostic/research tools. The earlier [classifier lab](docs/lab.md) and wake-prefix runtime are
historical experiments, not production activation paths. Their synthetic/unit results do not qualify
live speech reliability.