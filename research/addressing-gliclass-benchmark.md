# Experimental GLiClass addressee comparison

## Scope and protocol

This is one bounded alternate-model comparison, not permission to enable production admission.
The original GLiNER2 adapter, thresholds, fixtures, and results remain unchanged.

The candidate is
[knowledgator/gliclass-edge-v3.0](https://huggingface.co/knowledgator/gliclass-edge-v3.0), using the
[GLiClass zero-shot classification pipeline](https://github.com/Knowledgator/GLiClass).
The model card describes a 32.7M-parameter, 131 MB model and declares Apache-2.0. Generic topic,
sentiment, or NLI benchmark results are not evidence of safe addressee detection.

The same 48 authored synthetic text fixtures are **REUSED**, including the previously inspected
GLiNER2 development and heldout labels. These are not new or independent heldout results. Each
24-case split contains seven intended positives, eleven negatives, and six ambiguous utterances;
three positives per split have no assistant vocative. No recording, enrollment, training, private
conversation, microphone, playback, cloud inference, or agent dispatch is involved.

Before any real GLiClass inference, thresholds and label descriptions were fixed:

| Decision  | Minimum confidence | Margin over both other labels |
| --------- | ------------------ | ----------------------------- |
| Accept    | 0.95               | 0.35                          |
| Reject    | 0.90               | 0.25                          |
| Uncertain | Otherwise          | Not applicable                |

The labels describe a direct request to the coding assistant, speech to another listener or
self-talk including quoted commands, and ambiguous/incomplete addressee. Full wording is recorded
in the JSON report. Pipeline scores are independent confidence scores, **not calibrated
probabilities**, and need not sum to one. There is no keyword-based automatic admission.

The input is `Current spoken utterance:` followed by the utterance verbatim, with optional minimal
assistant context appended. Only active agent names, last assistant question, and responding state
are allowed; there is no room history. Exact pipeline-prepared input is tokenized without
truncation and rejected if over 512 tokens, rather than admitting from a silently truncated input.
Empty or overlong text, invalid context, model errors, and malformed/nonfinite scores fail closed
with a sanitized `ClassifierError`.

## Reproduction

The Nix worker alone packages the pinned model and dependency. Model revision is
`df03993a2ed98e5e4a0d2dd7efbbd105abe874cf`; hashes and provenance are recorded in
`models/lab-gliclass-manifest.json`. Reproduce the variant with:

```sh
nix-shell --argstr classifier gliclass --run \
  'python -P -m paj_voice_audio.lab_gliclass \
  --model "$PAJ_VOICE_MODEL_BUNDLE/classifier" \
  --benchmark tests/fixtures/addressing.json' \
  > research/addressing-gliclass-benchmark.json
```

Both model and tokenizer require an explicit existing absolute local directory and
`local_files_only=True`, with offline settings applied before inference imports. CPU inference
uses two PyTorch intra-operation threads and disables pipeline progress. Help and fake-model unit
tests require no inference dependencies. The benchmark emits synthetic fixture IDs and scores,
not raw utterance text; errors do not log rejected utterances.

## Actual results on REUSED splits

The real Nix-variant run completed successfully. All 48 utterances were uncertain: none were
accepted and none were rejected. Full scores and measured timings are in
`research/addressing-gliclass-benchmark.json`.

| REUSED split | False accepts | Missed positives | Rejected positives | Uncertain |
| ------------ | ------------- | ---------------- | ------------------ | --------- |
| Development  | 0 / 17        | 7 / 7            | 0 / 7              | 24 / 24   |
| Heldout      | 0 / 17        | 7 / 7            | 0 / 7              | 24 / 24   |

For each reused split, false accepts were 0% of the 17 nonpositives, misses were 100% of the seven
positives, and both automatic accept and reject fractions were 0%. These are sample summaries, not
estimates of household false-accept rates. Zero false accepts is vacuous when nothing is admitted;
uncertain does not count as a successful automatic rejection or acceptance.

All six wake-free positives and all eight remaining intended positives required clarification.
Reused-heldout missed-positive IDs were `h01`, `h02`, `h03`, `h04`, `h05`, `h06`, and `h23`.
Partner-topic cases `h08` and `h09`, quoted-command cases `h13`–`h15`, game speech, self-talk, and
ambiguous replies were all uncertain too.

The highest assistant-addressed score anywhere was only 0.78797, on negative quoted-command case
`h14`, not a true positive. For `h01`, a wake-free intended request, assistant/not-assistant/unclear
scores were approximately 0.369/0.740/0.930. For partner-topic `h08`, they were 0.372/0.708/0.652.
These overlapping independent scores are not evidence that lowering the threshold would be safe.
No threshold, prompt, label, or model was changed after seeing these results.

### Actual CPU timings

Hardware was the same Intel Core Ultra X7 358H. Inference used two PyTorch intra-operation threads,
verified in a separate real smoke check. Affinity was not pinned and the machine was not isolated
from other work. Versions were Python 3.13.15, GLiClass 0.1.22, PyTorch 2.13.0, and Transformers
5.17.0.

| Measurement                        | Elapsed time |
| ---------------------------------- | ------------ |
| Process-cold load plus imports     | 2723 ms      |
| First inference                    | 29 ms        |
| Remaining 47 inference median      | 37 ms        |
| Reused-development inference p95   | 46 ms        |
| Reused-heldout inference median    | 38 ms        |
| Reused-heldout inference p95       | 45 ms        |

Process-cold is not an OS-cache flush; the packaging worker had already smoke-tested the bundle.
The configured classifier stage was substantially faster than the recorded GLiNER2 path
(37 ms versus 365 ms warm median), but the adapters also use different label/input wording. This
is not a controlled architecture-only speed comparison. Neither measurement includes VAD, speech
recognition, endpointing, clarification, playback, or agent execution, and neither qualifies
latency under gaming load.

Transformers emitted a generic `GLiClass` model-type compatibility warning and a `use_return_dict`
deprecation warning; weight-loading progress also appeared on stderr. The model loaded and
inference completed, but these warnings are recorded rather than hidden. No utterances appeared
in these diagnostics.

### Checks

All eleven new fake-model unit tests passed without requiring inference dependencies. The full
current audio suite passed 130 tests in the GLiClass Nix variant. Tests cover thresholds/margins,
finite bounded scores, malformed/duplicate labels, context/input bounds, token truncation
prevention, local-only model/tokenizer arguments, sanitized errors, dependency-free help, and
correct alternate-model/reused-split report metadata.

A separate real smoke check denied socket connections and DNS lookups inside the Python process,
loaded the packaged model, and classified one invented synthetic sentence. It observed zero
network lookup or connection attempts and exactly two PyTorch intra-operation threads. An empty
existing model directory failed closed without a fallback download. No private text or audio was
used, and no dependency installation or model download was initiated by the classifier worker.

## Recommendation

**Not ready for unconfirmed addressee admission.** The smaller model is computationally cheap,
but this frozen setup is a universal clarification route, not a useful addressee filter. It would
prompt on partner conversation as well as genuine commands. Preserve the results and conservative
thresholds; do not lower them or claim that all-uncertain behavior proves safe discrimination.

Keep the original default unchanged pending parent review. Any lab use remains experimental,
commands-disabled, and disconnected from production dispatch. Confirmation/ASR safety can be
evaluated separately, but the classifier score is not an authority grant. This was the single
approved alternate-model comparison; no further models or tuning loop were attempted.
