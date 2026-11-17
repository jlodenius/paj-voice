import contextlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from paj_voice_audio.lab_gliclass import (
    ACCEPT_MARGIN, ACCEPT_THRESHOLD, Classifier, ClassifierError, LABELS,
    MAX_TEXT, MAX_TOKENS, MODEL, _decision, benchmark,
)


class FakeTokenizer:
    def __init__(self):
        self.length = 40
        self.calls = []

    def __call__(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return {"input_ids": [1] * self.length}


class FakePipeline:
    def __init__(self, scores=None):
        self.scores = scores if scores is not None else [.99, .01, .02]
        self.calls = []
        self.pipe = types.SimpleNamespace(prepare_input=lambda text, labels: "|".join(labels) + text)

    def __call__(self, text, labels, **kwargs):
        self.calls.append((text, labels, kwargs))
        return [[{"label": label, "score": score} for label, score in zip(labels, self.scores)]]


def fake_classifier(scores=None):
    classifier = Classifier.__new__(Classifier)
    classifier._torch = types.SimpleNamespace(inference_mode=contextlib.nullcontext)
    classifier._pipeline = FakePipeline(scores)
    classifier._tokenizer = FakeTokenizer()
    classifier.load_ms = 3.0
    return classifier


class GLiClassTests(unittest.TestCase):
    def test_conservative_confidence_and_margin(self):
        self.assertEqual(_decision(dict(zip(LABELS, [.99, .01, .02]))), "accept")
        self.assertEqual(_decision(dict(zip(LABELS, [.01, .99, .02]))), "reject")
        self.assertEqual(_decision(dict(zip(LABELS, [ACCEPT_THRESHOLD - .01, 0, 0]))), "uncertain")
        self.assertEqual(_decision(dict(zip(LABELS, [1, 1 - ACCEPT_MARGIN + .01, 0]))), "uncertain")
        self.assertEqual(_decision(dict(zip(LABELS, [.1, .1, .99]))), "uncertain")

    def test_bad_scores_fail_closed(self):
        for bad in (math.nan, math.inf, -.1, 1.1, "0.99", True, None):
            with self.subTest(bad=bad), self.assertRaises(ClassifierError):
                _decision(dict(zip(LABELS, [bad, .01, .02])))
        for bad in ({}, {"other": .99}, {**dict.fromkeys(LABELS, .1), "extra": .99}):
            with self.assertRaises(ClassifierError):
                _decision(bad)

    def test_no_keyword_promotion_or_raw_text_output(self):
        classifier = fake_classifier([.4, .3, .5])
        result = classifier.classify("Assistant Nix agent Paj run the tests")
        self.assertEqual(result["decision"], "uncertain")
        self.assertEqual(set(result), {"decision", "scores", "elapsedMs"})
        self.assertGreaterEqual(result["elapsedMs"], 0)

    def test_payload_labels_and_scores(self):
        classifier = fake_classifier()
        context = {"active_agents": ["Nix agent"], "last_question": "Check tests?", "responding": True}
        utterance = "I told my partner 'Assistant, check tests'"
        result = classifier.classify(utterance, context)
        self.assertEqual(result["decision"], "accept")
        payload, labels, kwargs = classifier._pipeline.calls[0]
        self.assertTrue(payload.startswith("Current spoken utterance:\n" + utterance))
        self.assertIn(json.dumps(context), payload)
        self.assertEqual(labels, list(LABELS.values()))
        self.assertIn("quoting a command", labels[0])
        self.assertEqual(kwargs, {"threshold": 0.0, "batch_size": 1})
        self.assertFalse(classifier._tokenizer.calls[0][1]["truncation"])

    def test_invalid_input_or_context_never_reaches_pipeline(self):
        classifier = fake_classifier()
        for text in (None, "", "  ", "private" * MAX_TEXT):
            with self.assertRaises(ClassifierError) as error:
                classifier.classify(text)
            self.assertNotIn("private", str(error.exception))
        for context in ({"history": "private"}, {"responding": 1}, {"active_agents": "agent"},
                        {"last_question": "q" * 301}, {"active_agents": ["a"] * 13}):
            with self.assertRaises(ClassifierError):
                classifier.classify("private", context)
        self.assertEqual(classifier._pipeline.calls, [])

    def test_token_bound_prevents_silent_truncation(self):
        classifier = fake_classifier()
        classifier._tokenizer.length = MAX_TOKENS + 1
        with self.assertRaises(ClassifierError):
            classifier.classify("Assistant, check tests")
        self.assertEqual(classifier._pipeline.calls, [])
        classifier._tokenizer.length = MAX_TOKENS
        self.assertEqual(classifier.classify("Assistant, check tests")["decision"], "accept")

    def test_malformed_outputs_and_errors_are_sanitized(self):
        classifier = fake_classifier()
        for output in (None, [], [[]], [[{"label": "unknown", "score": .99}] * 3],
                       [[{"label": LABELS["assistant_addressed"], "score": .99}] * 3]):
            classifier._pipeline = lambda *args, **kwargs: output
            classifier._pipeline.pipe = types.SimpleNamespace(prepare_input=lambda *args: "prepared")
            with self.assertRaises(ClassifierError) as error:
                classifier.classify("private")
            self.assertNotIn("private", str(error.exception))
        classifier = fake_classifier()
        def fail(*args, **kwargs):
            raise RuntimeError("private text")
        classifier._tokenizer = fail
        with self.assertRaisesRegex(ClassifierError, "local GLiClass inference failed"):
            classifier.classify("private")

    def test_explicit_model_directory(self):
        for path in ("knowledgator/gliclass-edge-v3.0", "", "/not/a/model/directory"):
            with self.assertRaises(ClassifierError):
                Classifier(path)

    def test_local_model_and_tokenizer_loading_with_cpu_threads(self):
        calls = []
        tokenizer = FakeTokenizer()
        model = types.SimpleNamespace(
            to=lambda device: calls.append(device) or model,
            eval=lambda: calls.append("eval"),
            config=types.SimpleNamespace(architecture_type="uni-encoder"),
        )
        def load_tokenizer(path, **kwargs):
            calls.append(("tokenizer", path, kwargs))
            return tokenizer
        def load_model(path, **kwargs):
            import os
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
            calls.append(("model", path, kwargs))
            return model
        def pipeline(loaded_model, loaded_tokenizer, **kwargs):
            self.assertIs(loaded_model, model)
            self.assertIs(loaded_tokenizer, tokenizer)
            calls.append(kwargs)
            return FakePipeline()
        modules = {
            "torch": types.SimpleNamespace(set_num_threads=lambda count: calls.append(count)),
            "transformers": types.SimpleNamespace(AutoTokenizer=types.SimpleNamespace(from_pretrained=load_tokenizer)),
            "gliclass": types.SimpleNamespace(
                GLiClassModel=types.SimpleNamespace(from_pretrained=load_model),
                ZeroShotClassificationPipeline=pipeline,
            ),
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules), patch.dict("os.environ", {}, clear=True):
            classifier = Classifier(directory)
        self.assertEqual(calls[0], 2)
        for name, path, kwargs in calls[1:3]:
            self.assertEqual(path, directory)
            self.assertTrue(kwargs["local_files_only"])
            self.assertFalse(kwargs["trust_remote_code"])
        self.assertEqual(calls[3:5], ["cpu", "eval"])
        self.assertEqual(calls[5], {"device": "cpu", "classification_type": "multi-label",
                                    "max_length": MAX_TOKENS, "progress_bar": False})
        self.assertGreaterEqual(classifier.load_ms, 0)

    def test_help_before_inference_imports(self):
        code = (
            "import sys; from paj_voice_audio.lab_gliclass import main; "
            "sys.argv=['gliclass','--help']; "
            "\ntry: main()\nexcept SystemExit: pass\n"
            "assert not any(m in sys.modules for m in ['torch','gliclass','transformers'])"
        )
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--benchmark", result.stdout)

    def test_benchmark_is_correctly_marked_reused_and_alternate(self):
        path = Path(__file__).resolve().parents[2] / "tests/fixtures/addressing.json"
        result = benchmark(fake_classifier(), path)
        self.assertEqual(result["model"], MODEL)
        self.assertEqual(result["backend"], "gliclass")
        self.assertTrue(result["splitReuse"])
        self.assertIn("not independent heldout", result["splitCaveat"])
        self.assertEqual(result["labelDescriptions"], LABELS)
        self.assertEqual(result["thresholds"]["accept"], ACCEPT_THRESHOLD)
        summary = result["splits"]["heldout"]
        self.assertEqual(summary["count"], 24)
        self.assertEqual(summary["acceptFraction"], 1)
        self.assertEqual(summary["rejectFraction"], 0)
        self.assertEqual(summary["falseAcceptFractionOfNonPositive"], 1)
        self.assertEqual(summary["missedPositiveFraction"], 0)
        self.assertNotIn("text", result["results"][0])


if __name__ == "__main__":
    unittest.main()
