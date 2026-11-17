import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from paj_voice_audio import lab


class Classifier:
    load_ms = 1

    def classify(self, text, context=None):
        return {"decision": "uncertain", "elapsedMs": 1, "scores": {}}


class Inference:
    backend = "gliner2"

    def __init__(self, root, speech=True):
        self.classifier = Classifier()


class LabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("stt/model.bin", "stt/config.json", "stt/tokenizer.json",
                     "tts/model.onnx", "tts/model.onnx.json", "classifier/config.json"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

    def test_bundle_is_explicit_and_complete(self):
        for bad in (None, "relative", str(self.root / "missing")):
            with self.assertRaises(ValueError):
                lab.model_bundle(bad)
        self.assertEqual(lab.model_bundle(str(self.root)), self.root)
        (self.root / "stt/model.bin").unlink()
        with self.assertRaises(ValueError):
            lab.model_bundle(str(self.root))

    def test_missing_mode_and_live_device_selection_fail_before_models(self):
        for args in ([], ["--live"], ["--live", "--input", "explicit"]):
            with patch.object(lab, "Inference") as factory:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    lab.main(args)
                factory.assert_not_called()

    def test_preflight_cannot_open_live_audio(self):
        output = io.StringIO()
        with patch.object(lab, "Inference", Inference), patch.object(lab, "live_trial") as live:
            with contextlib.redirect_stdout(output):
                result = lab.main(["--check", "--bundle", str(self.root)])
        self.assertEqual(result, 0)
        live.assert_not_called()
        self.assertIn('"hardwareQualified": false', output.getvalue())

    def text_trial(self, reply, readable=True, show=False):
        output = io.StringIO()
        args = ["--text", "PRIVATE ORIGINAL CANDIDATE", "--bundle", str(self.root)]
        if show:
            args.append("--show-accepted-text")
        stdin = io.StringIO(reply)
        stdin.isatty = lambda: True
        ready = ([stdin], [], []) if readable else ([], [], [])
        with patch.object(lab, "Inference", Inference), patch.object(lab.sys, "stdin", stdin):
            with patch.object(lab.select, "select", return_value=ready):
                with contextlib.redirect_stdout(output):
                    result = lab.main(args)
        self.assertEqual(result, 0)
        return output.getvalue()

    def test_yes_releases_original_once_without_default_text_logging(self):
        result = self.text_trial("Yes.\n")
        self.assertEqual(result.count('"event": "would_send"'), 1)
        self.assertNotIn("PRIVATE ORIGINAL CANDIDATE", result)
        self.assertIn('"dispatch": false', result)

    def test_unrelated_reply_does_not_replace_original_or_reprompt(self):
        result = self.text_trial("Tell my partner about dinner\n")
        self.assertNotIn("would_send", result)
        self.assertEqual(result.count("Was that message for me?"), 1)
        self.assertNotIn("Tell my partner", result)
        self.assertNotIn("PRIVATE ORIGINAL", result)

    def test_noninteractive_confirmation_is_discarded_without_blocking_read(self):
        output = io.StringIO()
        with patch.object(lab, "Inference", Inference), patch.object(lab.sys, "stdin", io.StringIO("yes")):
            with patch.object(lab.select, "select") as wait, contextlib.redirect_stdout(output):
                result = lab.main(["--text", "PRIVATE CANDIDATE", "--bundle", str(self.root)])
        self.assertEqual(result, 0)
        wait.assert_not_called()
        self.assertNotIn("would_send", output.getvalue())
        self.assertNotIn("PRIVATE CANDIDATE", output.getvalue())

    def test_qualified_yes_is_not_confirmation(self):
        self.assertNotIn("would_send", self.text_trial("yes but do not send it\n"))

    def test_accepted_text_logging_requires_opt_in(self):
        self.assertIn("PRIVATE ORIGINAL CANDIDATE", self.text_trial("of course\n", show=True))


if __name__ == "__main__":
    unittest.main()
