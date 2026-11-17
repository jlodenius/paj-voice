import contextlib
import io
import queue
import sys
import threading
import types
import unittest
from unittest.mock import patch

from paj_voice_audio import cli, devices, lab, lab_audio


RealQueue = queue.Queue
RealThread = threading.Thread


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds=0.2):
        self.now += seconds


class Array:
    def __mul__(self, other):
        return self

    __rmul__ = __mul__
    __truediv__ = __mul__

    def astype(self, dtype):
        return self

    def tobytes(self):
        return b"\0\0"


class Events(RealQueue):
    def __init__(self, owner, maxsize):
        super().__init__(maxsize)
        self.owner = owner

    def put_nowait(self, item):
        if self.owner.mode == "duplicate_results" and item.get("type") == "recognized":
            super().put_nowait(dict(item))
        return super().put_nowait(item)

    def get(self, block=True, timeout=None):
        if block and self.empty():
            self.owner.pump()
        return super().get(block, min(timeout, 0.01) if timeout is not None else None)


class LiveHarness:
    original = "PRIVATE original instruction"

    def __init__(self, answer="yes", mode="normal", decision="uncertain", show=False):
        self.clock = Clock()
        self.answer, self.mode, self.decision = answer, mode, decision
        self.args = types.SimpleNamespace(
            input="internal", output="headphones", seconds=15, playback_demo=True,
            show_accepted_text=show, agent=[], force_confirm=False,
        )
        self.effects, self.classified, self.transcribed = [], [], []
        self.threads = []
        self.queues = 0
        self.stage = "candidate"
        self.finished = False
        self.pumps = 0
        self.prompt = None
        self.output = io.StringIO()
        self.inference = types.SimpleNamespace(
            rate=16000,
            np=types.SimpleNamespace(arange=lambda count: Array(), sin=lambda values: Array(), pi=3.14),
            synthesize=lambda text: b"\0\0",
            transcribe=self.transcribe,
            classifier=types.SimpleNamespace(classify=self.classify),
        )

    def transcribe(self, pcm):
        self.transcribed.append(pcm)
        if self.mode == "inference_failure":
            raise RuntimeError("PRIVATE inference failure")
        if self.mode == "late_asr":
            self.clock.advance(11)
        return (self.original if len(self.transcribed) == 1 else self.answer), 1.0

    def classify(self, text, context):
        self.classified.append(text)
        return {"decision": self.decision, "elapsedMs": 1.0}

    def make_queue(self, maxsize):
        self.queues += 1
        result = Events(self, maxsize) if self.queues == 1 else RealQueue(maxsize)
        if self.queues == 1:
            self.events = result
        return result

    def thread(self, **kwargs):
        result = RealThread(**kwargs)
        self.threads.append(result)
        return result

    def feed_turn(self):
        self.clock.advance()
        self.segments.feed(b"\x01\0" * 160, True, captured_at=self.clock())
        self.clock.advance()
        self.segments.feed(b"\0\0" * 160, False, captured_at=self.clock())

    def emit_stale_events(self):
        self.capture.turns.emit({"type": "onset", "id": 900, "epoch": -1, "at": self.clock()})
        self.capture.turns.emit({"type": "endpoint", "id": 900, "pcm": b"stale", "truncated": False})
        self.capture.turns.emit({"type": "recognized", "token": object(), "text": "PRIVATE stale yes",
                                 "decision": "accept", "asrMs": 1, "classifierMs": 1})
        self.capture.turns.emit({"type": "played", "kind": "prompt", "id": -1, "epoch": -1})

    def pump(self):
        self.pumps += 1
        if self.pumps > 100:
            self.timer.callback()
            return
        if self.finished:
            self.timer.callback()
        elif self.stage == "candidate":
            self.stage = "waiting"
            if self.mode in ("interrupt", "close_failure"):
                raise KeyboardInterrupt
            if self.mode == "capture_failure":
                self.capture.fail(RuntimeError("PRIVATE capture failure"))
            elif self.mode == "timer":
                self.timer.callback()
            else:
                if self.mode == "stale_events":
                    self.emit_stale_events()
                self.feed_turn()
        elif self.prompt is not None:
            prompt, self.prompt = self.prompt, None
            if self.mode == "during_prompt":
                self.feed_turn()
            self.clock.advance()
            self.speaker.active = None
            self.events.put_nowait({"type": "played", **prompt})
            self.stage = "reply"
        elif self.stage == "reply":
            self.stage = "waiting"
            if self.mode == "silence":
                self.clock.advance(6)
            elif self.mode == "delayed_prompt_onset":
                self.capture.turns.emit({"type": "onset", "id": 901,
                                         "epoch": self.prompt_epoch, "at": self.clock() - 0.1})
                self.capture.turns.emit({"type": "endpoint", "id": 901,
                                         "pcm": b"prompt tail", "truncated": False})
                self.stage = "fresh_reply"
            else:
                self.feed_turn()
        elif self.stage == "fresh_reply":
            self.stage = "waiting"
            self.feed_turn()

    def run(self):
        owner = self

        class Graph:
            paths = {"pw-play": "FAKE", "pw-record": "FAKE"}

            def bind(self, source, target):
                return types.SimpleNamespace(name=source), types.SimpleNamespace(name=target)

            def check(self):
                if owner.mode == "device_failure":
                    raise RuntimeError("PRIVATE device health failure")

        class Lock:
            def __init__(self):
                owner.lock = self
                self.closed = False

            def close(self):
                self.closed = True

        class Sink:
            def __init__(self, *args):
                owner.sink = self
                self.closed = False

            def health(self):
                pass

            def close(self):
                self.closed = True

        class Speaker:
            def __init__(self, sink, emit):
                owner.speaker = self
                self.sink, self.emit = sink, emit
                self.active = self.saved = None
                self.closed = False
                self.resumes = 0
                self.discards = 0

            def play(self, pcm, kind, ident=None, epoch=None):
                self.active = {"kind": kind, "id": ident, "epoch": epoch}
                if kind == "prompt":
                    owner.prompt = dict(self.active)
                    owner.prompt_epoch = epoch

            def pause(self):
                if self.active and self.active["kind"] == "demo":
                    self.saved, self.active = self.active, None
                    self.emit({"type": "paused", "elapsedMs": 1})

            def cancel(self):
                self.active = None

            def discard(self):
                self.discards += 1
                self.saved = None

            def resume(self):
                self.resumes += 1
                if self.active is None:
                    self.active, self.saved = self.saved, None

            def close(self):
                self.closed = True
                self.active = self.saved = None
                self.sink.close()

        class Capture:
            def __init__(self, path, source, vad, threshold, turns, fail):
                owner.capture = self
                self.turns, self.fail = turns, fail
                self.closed = False

            def start(self):
                pass

            def wait_ready(self):
                if owner.mode == "readiness_failure":
                    raise RuntimeError("PRIVATE readiness failure")

            def health(self):
                pass

            def close(self):
                self.closed = True
                if owner.mode == "close_failure":
                    raise RuntimeError("PRIVATE capture close failure")

        class Timer:
            def __init__(self, seconds, callback):
                owner.timer = self
                self.seconds, self.callback = seconds, callback
                self.cancelled = False

            def start(self):
                pass

            def cancel(self):
                self.cancelled = True

        real_segments = lab_audio.Segments
        real_show = lab.show_effects

        def segments(*args):
            self.segments = real_segments(*args, clock=self.clock, silence=0.1)
            return self.segments

        def effects(items, show=False):
            self.effects.extend(dict(item) for item in items)
            if any(item["type"] in ("admit", "discard") for item in items):
                self.finished = True
            real_show(items, show)

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, {
                "pysilero_vad": types.SimpleNamespace(SileroVoiceActivityDetector=object),
            }))
            for target, name, replacement in (
                (devices, "Graph", Graph), (devices, "PipeSink", Sink),
                (cli, "AudioLock", Lock), (lab_audio, "LabCapture", Capture),
                (lab_audio, "Speaker", Speaker), (lab_audio, "Segments", segments),
                (lab.queue, "Queue", self.make_queue), (lab.threading, "Timer", Timer),
                (lab.threading, "Thread", self.thread), (lab.time, "monotonic", self.clock),
                (lab.time, "sleep", lambda seconds: None), (lab, "show_effects", effects),
            ):
                stack.enter_context(patch.object(target, name, replacement))
            stack.enter_context(contextlib.redirect_stdout(self.output))
            try:
                lab.live_trial(self.args, self.inference)
            finally:
                for thread in self.threads:
                    thread.join(0.3)

    def assert_closed(self, test):
        for resource in (self.capture, self.speaker, self.sink, self.lock, self.segments):
            test.assertTrue(resource.closed)
        test.assertTrue(self.timer.cancelled)
        test.assertEqual(self.timer.seconds, 15)
        test.assertFalse(any(thread.is_alive() for thread in self.threads))
        test.assertIsNone(self.segments.current)
        test.assertFalse(self.segments.preroll)


class LiveIntegrationTests(unittest.TestCase):
    def test_uncertain_yes_admits_only_original_once_without_default_transcript_logging(self):
        harness = LiveHarness()
        harness.run()
        self.assertEqual([item for item in harness.effects if item["type"] == "admit"], [
            {"type": "admit", "text": harness.original}
        ])
        self.assertEqual(harness.classified, [harness.original])
        self.assertEqual(len(harness.transcribed), 2)
        self.assertEqual(harness.output.getvalue().count('"event": "would_send"'), 1)
        self.assertNotIn("PRIVATE", harness.output.getvalue())
        self.assertEqual(harness.speaker.resumes, 0)
        self.assertEqual(harness.speaker.discards, 1)
        harness.assert_closed(self)

    def test_unrelated_reply_discards_original_resumes_demo_and_never_classifies_answer(self):
        harness = LiveHarness(answer="PRIVATE unrelated conversation")
        harness.run()
        self.assertNotIn("admit", [item["type"] for item in harness.effects])
        self.assertEqual(harness.classified, [harness.original])
        self.assertEqual(harness.speaker.resumes, 1)
        self.assertEqual(sum(item["type"] == "prompt" for item in harness.effects), 1)
        self.assertNotIn("PRIVATE", harness.output.getvalue())
        harness.assert_closed(self)

    def test_prompt_audio_and_delayed_prompt_onset_cannot_confirm(self):
        for mode in ("during_prompt", "delayed_prompt_onset", "stale_events", "duplicate_results"):
            with self.subTest(mode=mode):
                harness = LiveHarness(mode=mode)
                harness.run()
                self.assertEqual(len(harness.transcribed), 2)
                self.assertEqual(harness.classified, [harness.original])
                self.assertEqual(sum(item["type"] == "admit" for item in harness.effects), 1)
                self.assertNotIn("PRIVATE", harness.output.getvalue())
                harness.assert_closed(self)

    def test_confirmation_silence_and_expired_asr_never_admit(self):
        for mode in ("silence", "late_asr"):
            with self.subTest(mode=mode):
                harness = LiveHarness(mode=mode)
                harness.run()
                self.assertNotIn("admit", [item["type"] for item in harness.effects])
                self.assertIn("timeout", [item.get("reason") for item in harness.effects])
                harness.assert_closed(self)

    def test_classifier_reject_resumes_paused_demo_without_prompt(self):
        harness = LiveHarness(decision="reject")
        harness.run()
        self.assertEqual([item["type"] for item in harness.effects], ["discard", "resume"])
        self.assertEqual(harness.speaker.resumes, 1)
        self.assertEqual(len(harness.transcribed), 1)
        harness.assert_closed(self)

    def test_opt_in_shows_original_but_not_confirmation_answer(self):
        harness = LiveHarness(answer="of course", show=True)
        harness.run()
        self.assertIn(harness.original, harness.output.getvalue())
        self.assertNotIn('"text": "of course"', harness.output.getvalue())
        harness.assert_closed(self)

    def test_timer_and_keyboard_interrupt_close_all_owned_resources(self):
        for mode in ("timer", "interrupt"):
            with self.subTest(mode=mode):
                harness = LiveHarness(mode=mode)
                if mode == "interrupt":
                    with self.assertRaises(KeyboardInterrupt):
                        harness.run()
                else:
                    harness.run()
                self.assertEqual(harness.transcribed, [])
                self.assertNotIn("admit", [item["type"] for item in harness.effects])
                harness.assert_closed(self)

    def test_capture_close_failure_does_not_skip_other_resource_cleanup_or_mask_interrupt(self):
        harness = LiveHarness(mode="close_failure")
        with self.assertRaises(KeyboardInterrupt):
            harness.run()
        harness.assert_closed(self)
        self.assertNotIn("PRIVATE", harness.output.getvalue())

    def test_readiness_and_device_health_failure_close_all_resources(self):
        for mode in ("readiness_failure", "device_failure"):
            with self.subTest(mode=mode):
                harness = LiveHarness(mode=mode)
                with self.assertRaises(RuntimeError):
                    harness.run()
                self.assertNotIn("PRIVATE", harness.output.getvalue())
                harness.assert_closed(self)

    def test_capture_or_inference_failure_cleans_up_without_leaking_errors_or_text(self):
        for mode in ("capture_failure", "inference_failure"):
            with self.subTest(mode=mode):
                harness = LiveHarness(mode=mode)
                with self.assertRaisesRegex(RuntimeError, "audio or inference failure"):
                    harness.run()
                self.assertNotIn("PRIVATE", harness.output.getvalue())
                self.assertNotIn("admit", [item["type"] for item in harness.effects])
                harness.assert_closed(self)


if __name__ == "__main__":
    unittest.main()
