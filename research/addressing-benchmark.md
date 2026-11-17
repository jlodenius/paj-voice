# Experimental offline addressee benchmark

## Scope

This is a commands-disabled safety-lab experiment, not production admission qualification. Inputs
are 48 authored synthetic text fixtures in `tests/fixtures/addressing.json`; no microphone,
playback, recordings, enrollment, training, captured conversations, cloud inference, or dispatch is
involved.

The candidate is `fastino/gliner2-base-v1`, pinned at
`f9634218e53580c56edf0de97ca1a7d3f1c2354e`. Asset hashes and source provenance are in
`models/lab-manifest.json`. The Nix worker owns downloads, packaging, and dependency compatibility;
the adapter does not install packages or fetch models.

## Protocol fixed before inference

Each split has 24 cases: seven intended assistant-directed requests, eleven intended non-assistant
utterances, and six intentionally ambiguous utterances. Three positives per split omit assistant
vocatives entirely. Negatives include partner conversation about agents, game coordination,
self-talk, and reported or quoted commands. Minimal context may contain only active agent names,
the assistant's last question, and whether it is responding. A recent assistant question alone does
not establish who a subsequent short reply addresses.

Labels describe the **addressee**, not merely the subject matter. The adapter requests independent
confidence scores for all three labels. Scores are finite and bounded, but are **not calibrated
probabilities** and need not sum to one.

Thresholds were fixed before any real inference and are not tuned on either split:

| Decision  | Required label confidence | Margin over both other labels |
| --------- | ------------------------- | ----------------------------- |
| Accept    | At least 0.95             | At least 0.35                 |
| Reject    | At least 0.90             | At least 0.25                 |
| Uncertain | Anything else             | Not applicable                |

Uncertain is not a successful automatic admission: it requires the separate local clarification
FSM. Missed accepts include both uncertain and rejected positives; outright rejected positives are
also reported separately. False accepts include both intended negatives and ambiguous fixtures.

The fixture split is a development/heldout discipline, not an independent population sample: both
splits were invented by the same author. No real-world false-accept rate, acoustic accuracy,
calibration, latency under gaming load, or robustness to arbitrary household speech follows from
these fixtures.

## Reproduction

From the project root, after the Nix environment and model bundle are ready:

```sh
nix-shell --argstr classifier gliner2 --run 'python -P -m paj_voice_audio.lab_classifier \
  --model "$PAJ_VOICE_MODEL_BUNDLE/classifier" \
  --benchmark tests/fixtures/addressing.json' \
  > research/addressing-benchmark.json
```

The JSON report contains fixture IDs and model scores, not utterance text. Loading and first
inference are timed separately from later inferences. CPU intra-operation threads are fixed at two.
Loading requires an explicit existing absolute directory with offline Hugging Face settings; model,
input, context, and score failures raise sanitized `ClassifierError`, never an admission.

## Actual results

The real offline run completed successfully in the project Nix shell. Full per-fixture scores,
decisions, timings, and fixture hash are in `research/addressing-benchmark.json`.

| Split       | False accepts | Missed positives | Rejected positives | Uncertain |
| ----------- | ------------- | ---------------- | ------------------ | --------- |
| Development | 1 / 17        | 7 / 7            | 0 / 7              | 23 / 24   |
| Heldout     | 0 / 17        | 7 / 7            | 0 / 7              | 24 / 24   |

False-accept denominators include eleven negative and six ambiguous cases per split. No case in
either split received a reject decision. All fourteen intended positives were uncertain, including
all six wake-free positives. Zero heldout false accepts is therefore **not a successful
classifier**: it deferred every heldout utterance, including dinner conversation, quoted commands,
and direct requests.

The development false accept was `d11`, a game teammate utterance: "Nice shot, Alex. Cover me while
I reload." Its assistant-addressed score was 0.95246, unclear-addressee score 0.42891, and
not-assistant-addressed score 0.00248. It passed the predeclared accept threshold and margin despite
having the wrong addressee. The score is demonstrably not a calibrated guarantee of safety.

Heldout missed-positive IDs were `h01`, `h02`, `h03`, `h04`, `h05`, `h06`, and `h23`. All heldout
partner-topic cases (`h08`, `h09`) and quoted-command cases (`h13`–`h15`) were uncertain, not
confidently rejected. The intended six ambiguous cases were also uncertain. These authored examples
show poor discrimination, not a measured household false-accept rate.

### Actual CPU timings and environment

Hardware was an Intel Core Ultra X7 358H. PyTorch inference used two intra-operation threads; CPU
affinity was not pinned and the machine was not isolated from other work. The shell also bounds
common numerical-library thread settings to two.

| Measurement                    | Elapsed time |
| ------------------------------ | ------------ |
| Process-cold load plus imports | 4302 ms      |
| First inference                | 431 ms       |
| Remaining 47 inference median  | 365 ms       |
| Development inference median   | 351 ms       |
| Development inference p95      | 431 ms       |
| Heldout inference median       | 411 ms       |
| Heldout inference p95          | 768 ms       |

"Process-cold" does not mean an OS-page-cache flush; the Nix worker had already checked the bundle.
These timings exclude endpointing, speech recognition, clarification, playback, and agent work.
They are not a gaming-load or live-audio latency qualification.

Versions were Python 3.13.15, GLiNER2 2.1.0, PyTorch 2.13.0, and Transformers 5.17.0. Transformers
emitted a model-type compatibility warning while loading the `extractor` checkpoint. Loading and
inference completed, but compatibility deserves review before interpreting a future revised setup;
the warning was not suppressed or treated as evidence of correctness.

### Safety and tests

The base fake-model suite requires neither Torch nor GLiNER2. All eleven classifier unit tests
passed, and the current full audio suite passed 109 tests in the Nix environment. Help works before
inference imports. Tests cover conservative threshold/margin decisions, invalid or duplicated
scores, malformed context, rejected input bounds, sanitized failures, explicit model paths, and
local-only model loading arguments.

A separate real Nix smoke check loaded the model and classified one invented synthetic sentence
with process-local socket connection functions replaced by failing guards. It reported exactly two
PyTorch intra-operation threads. An empty existing model directory failed closed instead of
fetching a replacement. No microphone, playback, cloud inference, or private text was involved.

The adapter passes `local_files_only=True` to the model loader and sets offline environment flags
before importing inference dependencies. Upstream internal tokenizer helpers omit the literal
keyword; offline mode still enforced local loading in the socket-guard check. Adding explicit
internal tokenizer/model loader flags in the packaged dependency remains a defense-in-depth
packaging item, not a reason to loosen the offline requirement.

## Recommendation

**Not ready for unconfirmed addressed-turn admission.** Retain the frozen thresholds only as the
recorded experimental configuration; do not lower them to force these fixtures to pass. This
configuration would ask for clarification on essentially every utterance and still falsely accept
one authored game command. It is neither a useful rejection filter nor a trustworthy direct-admit
gate.

Keep the lab experimental, commands-disabled, and disconnected from production dispatch. Local
confirmation behavior can be tested independently, but a positive classifier score must not be
mistaken for validated addressee detection. No thresholds, labels, prompts, or models were changed
after inspecting these results, and no second model was downloaded. A future redesigned setup
needs a new, disjoint evaluation rather than tuning against this heldout split.
