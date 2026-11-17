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

from paj_voice_audio.lab_classifier import (
    ACCEPT_MARGIN, ACCEPT_THRESHOLD, Classifier, ClassifierError, LABELS, MAX_TEXT,
    _decision, benchmark,
)


class FakeModel:
    def __init__(self, scores=None):
        self.scores = scores if scores is not None else {
            "assistant_addressed": .98, "not_assistant_addressed": .02, "unclear_addressee": .03,
        }
        self.calls = []

    def classify_text(self, text, schema, **kwargs):
        self.calls.append((text, schema, kwargs))
        return {"addressee": [{"label": k, "confidence": v} for k, v in self.scores.items()]}


def fake_classifier(scores=None):
    classifier = Classifier.__new__(Classifier)
    classifier._model = FakeModel(scores)
    classifier._torch = types.SimpleNamespace(inference_mode=contextlib.nullcontext)
    classifier.load_ms = 12.0
    return classifier


class ClassifierTests(unittest.TestCase):
    def test_accept_requires_confidence_and_margin(self):
        self.assertEqual(_decision(dict(zip(LABELS, [.98, .01, .02]))), "accept")
        self.assertEqual(_decision(dict(zip(LABELS, [ACCEPT_THRESHOLD - .01, 0, 0]))), "uncertain")
        self.assertEqual(_decision(dict(zip(LABELS, [1, 1 - ACCEPT_MARGIN + .01, 0]))), "uncertain")
        self.assertEqual(_decision(dict(zip(LABELS, [.02, .98, .01]))), "reject")
        self.assertEqual(_decision(dict(zip(LABELS, [.05, .01, .99]))), "uncertain")
        self.assertEqual(_decision(dict(zip(LABELS, [.01, .89, .01]))), "uncertain")

    def test_scores_must_be_complete_finite_bounded_numbers(self):
        for value in (math.nan, math.inf, -.01, 1.01, "0.99", True, None):
            with self.subTest(value=value), self.assertRaises(ClassifierError):
                _decision(dict(zip(LABELS, [value, .01, .02])))
        for scores in ({}, {"other": .9}, {**dict.fromkeys(LABELS, .1), "extra": .1}):
            with self.assertRaises(ClassifierError):
                _decision(scores)

    def test_no_keyword_autoadmit(self):
        classifier = fake_classifier(dict(zip(LABELS, [.4, .3, .3])))
        result = classifier.classify("Nix agent run the tests assistant Paj")
        self.assertEqual(result["decision"], "uncertain")
        self.assertGreaterEqual(result["elapsedMs"], 0)
        self.assertNotIn("text", result)

    def test_prompt_describes_addressee_and_quotes_context(self):
        classifier = fake_classifier()
        context = {"active_agents": ["Nix agent"], "last_question": "Need a check?", "responding": True}
        classifier.classify("I told my partner 'Nix agent, check the build'", context)
        text, schema, kwargs = classifier._model.calls[0]
        self.assertIn("not its topic", text)
        self.assertIn(json.dumps(context), text)
        self.assertEqual(schema["addressee"]["labels"], LABELS)
        self.assertTrue(schema["addressee"]["multi_label"])
        self.assertEqual(schema["addressee"]["cls_threshold"], 0)
        self.assertTrue(kwargs["include_confidence"])

    def test_bad_input_context_fails_before_inference_without_text(self):
        classifier = fake_classifier()
        for value in ("", "   ", "private" * MAX_TEXT, None, 12):
            with self.assertRaises(ClassifierError) as error:
                classifier.classify(value)
            self.assertNotIn("private", str(error.exception))
        for context in ([], {"history": "private"}, {"active_agents": "agent"},
                        {"last_question": "q" * 301}, {"responding": 1},
                        {"active_agents": ["a"] * 13}):
            with self.assertRaises(ClassifierError):
                classifier.classify("private", context)
        self.assertEqual(classifier._model.calls, [])

    def test_model_errors_and_bad_results_are_sanitized(self):
        classifier = fake_classifier({"assistant_addressed": .99})
        with self.assertRaisesRegex(ClassifierError, "inference failed"):
            classifier.classify("private")
        classifier._model.classify_text = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("private"))
        with self.assertRaises(ClassifierError) as error:
            classifier.classify("private")
        self.assertNotIn("private", str(error.exception))

    def test_duplicate_or_extra_model_labels_fail_closed(self):
        classifier = fake_classifier()
        for labels in (["assistant_addressed"] * 3, list(LABELS) + ["assistant_addressed"]):
            classifier._model.classify_text = lambda *a, **kw: {
                "addressee": [{"label": label, "confidence": .99} for label in labels]
            }
            with self.assertRaises(ClassifierError):
                classifier.classify("Assistant, check the tests")

    def test_path_must_be_explicit_absolute_directory(self):
        for path in ("fastino/gliner2-base-v1", "/no/such/model/directory", ""):
            with self.assertRaises(ClassifierError):
                Classifier(path)

    def test_load_forces_offline_cpu_and_threads(self):
        calls = []
        model = types.SimpleNamespace(
            to=lambda device: calls.append(device) or model,
            eval=lambda: calls.append("eval"),
        )
        def load(path, **kwargs):
            import os
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
            self.assertTrue(kwargs["local_files_only"])
            calls.append(path)
            return model
        modules = {
            "torch": types.SimpleNamespace(set_num_threads=lambda n: calls.append(n)),
            "gliner2": types.SimpleNamespace(GLiNER2=types.SimpleNamespace(from_pretrained=load)),
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules), patch.dict("os.environ", {}, clear=True):
            classifier = Classifier(directory)
        self.assertEqual(calls, [2, directory, "cpu", "eval"])
        self.assertGreaterEqual(classifier.load_ms, 0)

    def test_help_does_not_import_inference_dependencies(self):
        code = (
            "import sys; from paj_voice_audio.lab_classifier import main; "
            "sys.argv=['classifier','--help']; "
            "\ntry: main()\nexcept SystemExit: pass\n"
            "assert 'torch' not in sys.modules and 'gliner2' not in sys.modules"
        )
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--benchmark", result.stdout)

    def test_synthetic_fixture_and_benchmark_summary(self):
        path = Path(__file__).resolve().parents[2] / "tests/fixtures/addressing.json"
        fixture = json.loads(path.read_text())
        cases = fixture["cases"]
        self.assertEqual(len(cases), 48)
        self.assertEqual(len({c["id"] for c in cases}), len(cases))
        self.assertEqual({c["split"] for c in cases}, {"development", "heldout"})
        self.assertTrue(all(c["expected"] in ("accept", "reject", "uncertain") for c in cases))
        result = benchmark(fake_classifier(), path)
        self.assertTrue(result["syntheticOnly"])
        self.assertEqual(result["splits"]["heldout"]["count"], 24)
        self.assertIn("h08", result["splits"]["heldout"]["falseAcceptIds"])
        self.assertNotIn("text", result["results"][0])
        self.assertEqual(result["thresholds"]["accept"], ACCEPT_THRESHOLD)


if __name__ == "__main__":
    unittest.main()
