# Voice commands and behavior

[Back to setup](../README.md).

## Commands

| Command                         | What it does                                        |
| ------------------------------- | --------------------------------------------------- |
| `/paj-voice on`                 | Start Voice, with confirmation.                     |
| `/paj-voice off`                | Request audio shutdown; agent work continues.       |
| `/paj-voice pause` / `resume`   | Pause audio / resume with fresh confirmation.       |
| `/paj-voice reload`             | Apply saved preferences to the armed session.       |
| `/paj-voice pause 10 seconds`   | Pause only the microphone for a bounded duration.   |
| `/paj-voice stop`               | Stop the current spoken reply, not agent work.      |
| `/paj-voice route [name]`       | List saved audio selections or switch to one.       |
| `/paj-voice protection <name>`  | Edit speaker protection while Voice is off.         |
| `/paj-voice status`             | Show current state and settings location.           |
| `/paj-voice devices` / `voices` | List audio devices / installed speaking voices.     |
| `/paj-voice recover`            | Put an overlong dictation in the editor for review. |

`mute` and `unmute` are aliases for `pause` and `resume`. The panel's `Audio:` row shows the
current selection. You can also ask to switch to a saved selection while Voice is listening.

For device loss or fallback, see [audio recovery](troubleshooting.md#audio-recovery).

Type `/paj-voice reload` in the active terminal after saving [preferences](settings.md). With no
effective changes, nothing restarts. If only speaking voice, volume or speed changes, speech already
synthesizing or playing keeps its settings; queued speech uses the new settings if synthesis
starts after the swap. Other preference changes restart the armed worker and run fresh microphone
warm-up without a second arm prompt; in-flight audio is not replayed. Reload waits for confirmed
closure before opening capture. It does not arm Voice, resume a paused microphone, or authorize
changed routes, endpoints or fallback consent. Use the ordinary Voice controls for those changes.

## Speaker protection

Headphones allow spoken interruption with protection off. With protection on, wait for LISTENING
or use `/paj-voice stop`. Bluetooth microphones may switch to headset call mode, reducing
playback quality.

Ordinary `/paj-voice setup <name>` asks you to explicitly choose speakers/uncertain playback
(protection ON) or confirm headphones (protection OFF). Protection ON is the conservative first
choice. Device metadata is advisory, never proof: Bluetooth is always unknown, and a headphone hint
never saves a choice automatically. No choice or canceled confirmation means no changes.

Protection ON is **half-duplex**, not acoustic echo cancellation: recognition pauses during all
Voice output (including receipts, answers, narration, status and fallback speech), through its tail
and until quiet. Voice barge-in is unavailable during this interval. Use typed `/paj-voice stop`,
also displayed in the panel; agent work continues. Protection OFF retains full-duplex headphone
operation.
Background speech or music outside Voice playback can still become requests; headphones are safer.

To change only an existing route's protection, without selecting new devices:

```text
/paj-voice protection desk speakers
/paj-voice protection headset headphones
```

Omit the last argument for a chooser. Both choices require confirmation in a main Pi TUI with Voice
fully off. Nothing is hot-applied or automatically rearmed; the saved choice applies at the next
manual arm. Existing routes without a `speakerMode` flag remain unchanged until you explicitly
choose. The command changes only that private flag, preserving exact endpoints, route names,
preferred
selection and fallback. Protection cannot be disabled on the configured automatic fallback route.

Setup saves new bindings without changing an existing preferred route unless you explicitly select
“Make preferred.” The first route becomes the initial preferred route with confirmation. Replacing
an existing binding is disclosed in the final confirmation. Setup and protection edits refuse stale
consent or concurrent route changes rather than overwrite them. Choices use the existing private,
user-owned atomic store; shared preferences are unchanged.

## Timed microphone pause

While Voice is already armed, use `/paj-voice pause 10 seconds` or say “mute for 10 seconds”.
The spoken request uses `voice_pause_input` with integer `seconds` and the current generation/epoch.
This closes only microphone capture and discards partial or in-flight recognition. Speech output,
agent work, and normal tool permissions continue. It never arms Voice from off, startup, or a full
pause, and cannot approve terminal confirmations.

A request initially shows **MIC PAUSING**: recorder closure is unconfirmed, so do not assume
privacy.
The tool returns `requested`, not proof of closure. Only a matching native shutdown acknowledgement
confirms the paused state and starts displaying the native remaining time. The duration runs from
the request, not from acknowledgement. Missing acknowledgement after three seconds or a transport
failure stops Voice through its normal companion-close path and reports closure as unconfirmed.
A late acknowledgement cannot restore listening after that failure or an explicit stop.

Typed `pause` and `mute` accept an optional `for` and an exact integer duration: `seconds`, `sec`,
`s`, `minutes`, `min`, or `m` (singular words also work). The total must be 1–300 seconds.
Fractions, signs, mixed units, trailing words, and durations without units are rejected. For example,
`/paj-voice mute for 1 minute` pauses capture for 60 seconds.

A new request replaces the deadline from now; retrying the same tool-call ID does not extend it.
Up to 512 distinct requests are accepted per armed session; rearm with normal confirmation if this
limit is reached, rather than forgetting old IDs and extending a retried request.
The native runtime owns the monotonic deadline. The panel countdown is status only: zero means
fresh warmup, not listening. Wait for readiness; speaker-safe routes still wait for playback and
quiet before recognizing speech. Expiry does not replay discarded recognition or old speech.

Automatic resume requires the same armed session and the exact saved input/output endpoint
identities. Off, full pause, shutdown, session replacement, route switching, or an explicit stop
cancels that intent. If either endpoint disappears or the pair would change, the microphone stays
held, even if the original pair later returns. No pair-changing fallback is selected while paused;
existing fallback settings are unchanged. Output recovery remains independent. Use
`/paj-voice resume` for normal fresh confirmation rather than silently opening another microphone.

Closing capture can cause Bluetooth headset profile changes, such as HFP to A2DP, after a delay.
Changed profile nodes or serials conservatively hold the microphone rather than broadening resume
permission to another endpoint. This feature has fake-test coverage, not hardware qualification;
automatic resume is not guaranteed across headset profile churn.

Recorder teardown must confirm child-process exit before acknowledging a pause. On a close error or
unconfirmed exit, Voice cancels timed resume, reports a sanitized privacy error, and retains the
recorder for cleanup retries. Failure may stop speech output too. If cleanup still cannot confirm
exit, the error is not a claim that the microphone is physically closed.

Bare `/paj-voice pause` or `/paj-voice mute` requests shutdown of **all** Voice audio, as does
`/paj-voice off`. Wait for the audio process closure notice before assuming microphone privacy.
`/paj-voice status` distinguishes `closing`, `closed`, and `unconfirmed` teardown. If closure
cannot be confirmed in time, Voice will not rearm until it observes the previous process exit;
request `on` or `resume` again after that. A late exit never rearms Voice by itself. `/paj-voice
resume` always uses fresh confirmation, including when ending a timed pause early.

## Recovering long dictation

At `maxMessageSeconds`, stop speaking. Voice keeps the captured transcript in memory rather than
submitting an unfinished request. `/paj-voice recover` loads it into an empty Pi editor for review;
complete it before sending. Up to four drafts are retained, after which Voice stops.

Drafts survive off/pause but are cleared when switching sessions or quitting Pi. They are not audio
recordings. Audio is processed locally; recognized text goes to Pi's provider and session history.

## Recognition safeguards

Voice discards punctuation-only output, output whose decoder evidence indicates unreliable
non-speech, and repeated decoder loops that are implausibly long for the VAD-positive capture time.
Rejected captures show a warning and submit nothing; they are never shortened into an actionable
acknowledgement. Short answers and plausible intentional repetition are still allowed.

These are conservative admission checks, not a cough classifier or a guarantee against
hallucinations.
A confidently decoded noise sound can still look like speech, and legitimate speech can occasionally
be rejected. Potential speech can still interrupt a readout before recognition rejects it. Repeat
the
request if needed. No raw audio or rejected transcript is saved by these checks.

## Spoken answers

Voice reads concise plain-text answers aloud by default, even after a progress update or with a
reporting integration active. An already queued spoken answer is not repeated. Longer or formatted
replies need a separate spoken summary from the model; Voice does not read the full reply aloud.
If the model omits that summary, Voice can report the omission without asking you to request it.

## Incoming agent updates

With compatible Paj, incoming updates request a concise summary from your current Pi model. The
arrival notice is separate from the meaningful summary. Important results, blockers, and questions
remain spoken even when routine progress updates are disabled.

If an inbox-only response omits a usable summary, Voice requests one fresh summary automatically,
once per pending batch. It never replays old audio or substitutes a stale user-request token.
Stopping speech or starting a new request cancels an obsolete retry; explicit silence is respected.
If the retry still cannot produce a summary, Voice reports that failure once rather than repeatedly
asking you to request a summary. An inbox summary does not complete unrelated user work.
