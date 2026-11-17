import array
import contextlib
import io
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

from paj_voice_audio import cli, devices, stt_eval


class Recognizer:
    def __init__(self, path=None):
        self.seen = []

    def transcribe(self, pcm):
        self.seen.append(pcm)
        return "Yes.", 1.5


def recording():
    result = stt_eval.Recording(7)
    for voiced, count in ((False, 35), (True, 10), (False, 50)):
        for _ in range(count):
            result.feed((b"\0\x08" if voiced else b"\0\0") * 512, voiced)
    result.close()
    return result


class PairedTests(unittest.TestCase):
    def test_exact_same_source_compared_with_both_real_segmenters(self):
        source = recording()
        raw = b"".join(pcm for pcm, _ in source.frames)
        candidates = stt_eval.paths(source)
        self.assertEqual(candidates["full"]["pcm"], [raw])
        for name in ("lab", "production"):
            self.assertEqual(len(candidates[name]["pcm"]), 1)
            self.assertIn(candidates[name]["pcm"][0], raw)
            self.assertFalse(candidates[name]["unfinished"])
        self.assertGreater(len(candidates["production"]["pcm"][0]),
                           len(candidates["lab"]["pcm"][0]))
        recognizer = Recognizer()
        budget = [3]
        report = stt_eval.evaluate(source, recognizer, "Yes", budget)
        self.assertEqual(recognizer.seen[0], raw)
        self.assertEqual(recognizer.seen[1:], [candidates["lab"]["pcm"][0],
                                             candidates["production"]["pcm"][0]])
        self.assertEqual(budget, [0])
        self.assertTrue(all(value["exact"] for value in report["paths"].values()))

    def test_no_vad_is_reported_not_repaired_with_padding(self):
        source = stt_eval.Recording(7)
        for _ in range(100):
            source.feed(b"\0" * 1024, False)
        source.close()
        recognizer = Recognizer()
        report = stt_eval.evaluate(source, recognizer, "Yes", [3])
        self.assertEqual(len(recognizer.seen), 1)
        self.assertEqual(report["paths"]["lab"]["segments"], [])
        self.assertFalse(report["paths"]["production"]["exact"])

    def test_unfinished_turn_is_not_artificially_endpointed(self):
        source = stt_eval.Recording(7)
        source.feed(b"\0\x08" * 512, True)
        source.close()
        candidates = stt_eval.paths(source)
        for name in ("lab", "production"):
            self.assertTrue(candidates[name]["unfinished"])
            self.assertEqual(candidates[name]["pcm"], [])

    def test_budget_checked_before_any_decode(self):
        recognizer = Recognizer()
        with self.assertRaisesRegex(RuntimeError, "budget"):
            stt_eval.evaluate(recording(), recognizer, "Yes", [2])
        self.assertFalse(recognizer.seen)

    def test_clipping_and_ram_bound(self):
        source = stt_eval.Recording(1)
        source.feed(array.array("h", [32767, -32768, 0, 0]).tobytes(), True)
        self.assertEqual(stt_eval.levels(source)["clippedSamples"], 2)
        self.assertEqual(stt_eval.levels(source)["clipFraction"], 0.5)
        with self.assertRaises(RuntimeError):
            source.feed(b"\0" * 40000, False)
        source.clear()
        self.assertEqual(source.frames, [])
        self.assertEqual(source.size, 0)
        source.feed(b"\0\0", True)
        self.assertEqual(source.size, 0)

    def test_level_trace_locates_saturation_and_dc_offset(self):
        source = stt_eval.Recording(1)
        source.feed(array.array("h", [32767] * 4000).tobytes(), False)
        source.feed(b"\0" * 8000, False)
        trace = stt_eval.level_trace(source)
        self.assertEqual(len(trace), 2)
        self.assertEqual(trace[0]["clipFraction"], 1)
        self.assertGreater(trace[0]["mean"], 0.99)
        self.assertEqual(trace[1]["clipFraction"], 0)
        self.assertEqual(trace[1]["rms"], 0)
        self.assertEqual(trace[1]["start"], 0.25)

    def test_levels_only_does_not_load_whisper_or_decode(self):
        captured = []

        class Graph:
            def snapshot(self):
                return [{"type": "PipeWire:Interface:Node", "info": {
                    "state": "suspended", "props": {"node.name": "internal",
                    "media.class": "Audio/Source", "object.serial": "42"},
                    "params": {"Props": [{"channelVolumes": [0.5], "softVolumes": [1.0]}]}}}]

        def capture(graph, source, seconds, recording, **kwargs):
            self.assertTrue(kwargs["silent"])
            self.assertFalse(kwargs["warmup"])
            recording.feed(b"\0" * 8000, False)
            recording.close()
            captured.append(recording)

        stdin = io.StringIO()
        stdin.isatty = lambda: True
        fake = types.SimpleNamespace(SileroVoiceActivityDetector=lambda: None)
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, {"pysilero_vad": fake}))
            load = stack.enter_context(patch.object(stt_eval, "Recognizer"))
            stack.enter_context(patch.object(stt_eval.sys, "stdin", stdin))
            stack.enter_context(patch.object(devices, "Graph", Graph))
            stack.enter_context(patch.object(stt_eval, "capture_window", capture))
            stack.enter_context(patch.object(stt_eval.time, "sleep", lambda seconds: None))
            stack.enter_context(patch("builtins.input", return_value=""))
            stack.enter_context(contextlib.redirect_stdout(output))
            result = stt_eval.main(["--run", "--levels-only", "--input", "internal"])
        self.assertEqual(result, 0)
        load.assert_not_called()
        self.assertEqual(len(captured), 2)
        self.assertTrue(all(item.closed and not item.frames for item in captured))
        self.assertIn("Whisper is not loaded", output.getvalue())
        self.assertNotIn("normalizedExactMatches", output.getvalue())

    def test_scores_do_not_normalize_away_names_or_qualifiers(self):
        self.assertTrue(stt_eval.score("What's for dinner?", "What is for dinner.")["exact"])
        self.assertFalse(stt_eval.score("Nix agent", "next agent")["exact"])
        self.assertFalse(stt_eval.score("Yes but do not send it", "Yes")["exact"])
        self.assertEqual(stt_eval.score("", "you")["wordEdits"], 1)
        report = stt_eval.evaluate(recording(), Recognizer(), "Yes but do not send it", [3])
        self.assertTrue(report["paths"]["lab"]["isolatedYesInQualifiedReply"])

    def test_check_does_not_construct_capture_or_graph(self):
        fake = types.SimpleNamespace(SileroVoiceActivityDetector=lambda: None)
        with patch.dict(sys.modules, {"pysilero_vad": fake}):
            with patch.object(stt_eval, "Recognizer", Recognizer), patch.object(devices, "Graph") as graph:
                with patch.object(stt_eval, "capture_window") as capture:
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(stt_eval.main(["--check", "--model", "/fake"]), 0)
                capture.assert_not_called()
                graph.assert_not_called()

    def test_single_phrase_selection_runs_only_requested_prompt(self):
        class Graph:
            def snapshot(self):
                return [{"type": "PipeWire:Interface:Node", "info": {"props": {
                    "node.name": "internal", "media.class": "Audio/Source", "object.serial": "42"}}}]

        def capture(graph, source, seconds, target, **kwargs):
            original = recording()
            for pcm, voiced in original.frames:
                target.feed(pcm, voiced)
            target.close()

        stdin = io.StringIO()
        stdin.isatty = lambda: True
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, {"pysilero_vad":
                                types.SimpleNamespace(SileroVoiceActivityDetector=lambda: None)}))
            stack.enter_context(patch.object(stt_eval, "Recognizer", Recognizer))
            stack.enter_context(patch.object(stt_eval.sys, "stdin", stdin))
            stack.enter_context(patch.object(devices, "Graph", Graph))
            stack.enter_context(patch.object(stt_eval, "capture_window", capture))
            stack.enter_context(patch.object(stt_eval.time, "sleep", lambda seconds: None))
            stack.enter_context(patch("builtins.input", return_value=""))
            stack.enter_context(contextlib.redirect_stdout(output))
            result = stt_eval.main(["--run", "--phrase", "yes", "--model", "/fake", "--input", "internal"])
        self.assertEqual(result, 0)
        self.assertEqual(output.getvalue().count('"phrase": "yes"'), 1)
        self.assertNotIn('[silence]', output.getvalue())
        self.assertIn('"phrases": 1', output.getvalue())

    def test_run_requires_explicit_input_and_terminal_before_loading_model(self):
        with patch.object(stt_eval, "Recognizer") as load:
            with patch.object(stt_eval.sys, "stdin", io.StringIO()):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    stt_eval.main(["--run", "--model", "/fake", "--input", "internal"])
            load.assert_not_called()


class WarmCaptureTests(unittest.TestCase):
    def exercise(self, bad=False, race=False):
        state = {"timers": [], "durations": []}
        recording = stt_eval.Recording(7)
        real_timer = threading.Timer
        real_gate = stt_eval.InputReady

        class RaceGate(real_gate):
            first = True

            def arm(self):
                if self.first:
                    self.first = False
                    self.feed(b"\0\x80" * 512, False)
                    result = super().arm()
                    self.assertion = result is None

                    def recover():
                        for _ in range(4):
                            self.feed(b"\0" * 8000, False)

                    recovery = real_timer(0.01, recover)
                    recovery.daemon = True
                    recovery.start()
                    return result
                return super().arm()

        class Lock:
            def close(self):
                state["lock_closed"] = True

        class Capture:
            def __init__(self, *args):
                state["capture"] = self
                self.receiver = args[-2]

            def start(self):
                for _ in range(30):
                    self.receiver.feed((b"\0\x80" if bad else b"\0\0") * 512, False,
                                       captured_at=time.monotonic())

            def wait_ready(self):
                pass

            def health(self):
                pass

            def close(self):
                state["capture_closed"] = True

        def timer(seconds, callback):
            index = len(state["timers"])
            state["durations"].append(seconds)

            def expire():
                if index == 1:
                    state["capture"].receiver.feed(b"\0\x08" * 512, True,
                                                   captured_at=time.monotonic())
                callback()

            instance = real_timer(0.03 if index else (0.05 if bad else 0.5), expire)
            state["timers"].append(instance)
            return instance

        graph = types.SimpleNamespace(paths={"pw-record": "FAKE"}, check=lambda: None)
        fake = types.SimpleNamespace(SileroVoiceActivityDetector=object)
        output = io.StringIO()
        with patch.dict(sys.modules, {"pysilero_vad": fake}):
            with patch.object(cli, "AudioLock", Lock), patch.object(stt_eval, "LabCapture", Capture):
                with patch.object(stt_eval.threading, "Timer", timer), contextlib.redirect_stdout(output):
                    with patch.object(stt_eval, "InputReady", RaceGate if race else real_gate):
                        if bad:
                            with self.assertRaisesRegex(RuntimeError, "before input became ready"):
                                stt_eval.capture_window(graph, object(), 7, recording)
                        else:
                            stt_eval.capture_window(graph, object(), 7, recording)
        self.assertTrue(state["capture_closed"])
        self.assertTrue(state["lock_closed"])
        self.assertTrue(recording.closed)
        self.assertTrue(all(not item.is_alive() for item in state["timers"]))
        if bad:
            self.assertEqual(recording.size, 0)
            self.assertNotIn("SPEAK NOW", output.getvalue())
            self.assertEqual(state["durations"], [12])
        else:
            self.assertEqual(recording.frames, [(b"\0\x08" * 512, True)])
            self.assertEqual(state["durations"], [12, 7])
            if race:
                self.assertTrue(state["capture"].receiver.assertion)
                self.assertNotIn('"warmup": null', output.getvalue())
            else:
                self.assertIn('"discardedSeconds": 0.96', output.getvalue())
            self.assertIn("SPEAK NOW", output.getvalue())

    def test_healthy_warmup_drops_calibration_and_captures_first_post_cue_frame(self):
        self.exercise()

    def test_unstable_input_never_announces_speak_or_records_speech(self):
        self.exercise(bad=True)

    def test_lost_readiness_recovers_without_starting_recording_prematurely(self):
        self.exercise(race=True)


class CaptureTests(unittest.TestCase):
    def run_capture(self, fail_close=False):
        state = {}
        source = stt_eval.Recording(7)

        class Lock:
            def close(self):
                state["lock_closed"] = True

        class Capture:
            def __init__(self, *args):
                self.receiver = args[-2]

            def start(self):
                self.receiver.feed(b"\0" * 1024, False)

            def wait_ready(self):
                state["timer"].callback()

            def health(self):
                pass

            def close(self):
                state["capture_closed"] = True
                if fail_close:
                    raise RuntimeError("close failure")

        class Timer:
            def __init__(self, seconds, callback):
                state["timer"] = self
                self.callback = callback

            def start(self):
                pass

            def cancel(self):
                pass

            def join(self, timeout):
                state["joined"] = True

            def is_alive(self):
                return False

        graph = types.SimpleNamespace(paths={"pw-record": "FAKE"}, check=lambda: None)
        fake = types.SimpleNamespace(SileroVoiceActivityDetector=object)
        with patch.dict(sys.modules, {"pysilero_vad": fake}):
            with patch.object(cli, "AudioLock", Lock), patch.object(stt_eval, "LabCapture", Capture):
                with patch.object(stt_eval.threading, "Timer", Timer):
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        if fail_close:
                            with self.assertRaises(RuntimeError):
                                stt_eval.capture_window(graph, object(), 7, source, warmup=False)
                        else:
                            stt_eval.capture_window(graph, object(), 7, source, warmup=False)
        self.assertTrue(state["joined"])
        self.assertTrue(state["capture_closed"])
        self.assertTrue(state["lock_closed"])
        self.assertTrue(source.closed)
        self.assertEqual(source.size, 1024)

    def test_capture_is_stopped_and_deadline_joined_before_return(self):
        self.run_capture()

    def test_close_failure_still_releases_lock_and_prevents_recognition(self):
        self.run_capture(fail_close=True)


if __name__ == "__main__":
    unittest.main()
