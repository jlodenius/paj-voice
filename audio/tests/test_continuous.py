import contextlib
import io
import json
from pathlib import Path
import queue
import sys
import threading
import types
import unittest
from unittest.mock import patch

from paj_voice_audio import cli, continuous, devices, lab_audio


class ExchangeTests(unittest.TestCase):
    def test_new_speech_invalidates_old_reply_but_new_turn_can_reply(self):
        exchange = continuous.Exchange()
        first = exchange.onset()
        exchange.endpoint(first)
        self.assertTrue(exchange.can_reply(first, "review the tests"))
        second = exchange.onset()
        self.assertFalse(exchange.can_reply(first, "old response"))
        self.assertFalse(exchange.can_reply(second, "unfinished speech"))
        exchange.endpoint(first)
        self.assertFalse(exchange.can_reply(second, "still speaking"))
        exchange.endpoint(second)
        self.assertTrue(exchange.can_reply(second, "focus on failures"))
        exchange.close()
        self.assertFalse(exchange.can_reply(second, "late result"))
        self.assertIsNone(exchange.onset())

    def test_preflight_skips_classifier_and_never_enters_trial(self):
        output = io.StringIO()
        with patch.object(continuous, "model_bundle", return_value=Path("/fake")) as bundle:
            with patch.object(continuous, "Inference") as load, patch.object(continuous, "trial") as run:
                with contextlib.redirect_stdout(output):
                    result = continuous.main(["--check", "--bundle", "/fake"])
        self.assertEqual(result, 0)
        bundle.assert_called_once_with("/fake", classifier=False)
        load.assert_called_once_with(Path("/fake"), classify=False)
        run.assert_not_called()

    def test_speech_inference_can_load_without_any_classifier_imports(self):
        from paj_voice_audio.lab import Inference

        voice = types.SimpleNamespace(config=types.SimpleNamespace(sample_rate=16000))
        modules = {
            "numpy": types.SimpleNamespace(),
            "faster_whisper": types.SimpleNamespace(WhisperModel=lambda *args, **kwargs:
                types.SimpleNamespace(supported_languages=["en"])),
            "piper": types.SimpleNamespace(PiperVoice=types.SimpleNamespace(load=lambda *args, **kwargs: voice)),
            "pysilero_vad": types.SimpleNamespace(SileroVoiceActivityDetector=lambda:
                types.SimpleNamespace(chunk_bytes=lambda: 1024)),
            "torch": None, "gliner2": None, "gliclass": None,
        }
        with patch.dict(sys.modules, modules):
            inference = Inference(Path("/fake"), classify=False)
        self.assertIsNone(inference.classifier)
        self.assertEqual(inference.backend, "disabled")

    def test_owned_reply_echo_is_flagged_without_treating_all_words_as_echo(self):
        self.assertTrue(continuous.echo_candidate(continuous.RESPONSE))
        self.assertTrue(continuous.echo_candidate("nothing was executed"))
        self.assertFalse(continuous.echo_candidate("review the tests"))
        self.assertFalse(continuous.echo_candidate("yes"))
        exchange = continuous.Exchange()
        generation = exchange.onset()
        exchange.endpoint(generation)
        self.assertFalse(exchange.can_reply(generation, continuous.RESPONSE))
        self.assertFalse(exchange.can_reply(generation, ""))


class Vector:
    def __mul__(self, other):
        return self

    __rmul__ = __mul__
    __truediv__ = __mul__

    def astype(self, dtype):
        return self

    def tobytes(self):
        return b"TT"


class ContinuousHarnessTests(unittest.TestCase):
    def exercise(self, overlap=False, failure=None, agent_mode=False, warmup_only=False):
        real_queue, real_thread = queue.Queue, threading.Thread
        now = [100.0]
        state = {"queues": 0, "turns": 0, "responses": 0, "threads": [], "capture_starts": 0}
        first_started, release = threading.Event(), threading.Event()
        output = io.StringIO()

        def clock():
            return now[0]

        def feed():
            now[0] += 0.1
            state["gate"].feed(b"\0\x08" * 512, True, captured_at=clock())
            now[0] += 0.9
            state["gate"].feed(b"\0" * 1024, False, captured_at=clock())
            state["turns"] += 1

        def pump():
            if state["turns"] == 0:
                feed()
            elif overlap and state["turns"] == 1 and first_started.is_set():
                feed()
                release.set()
            elif failure == "disconnect" and state["responses"] == 1:
                state["agent_fault"]()
            elif not overlap and state["turns"] == 1 and state["responses"] == 1:
                feed()
            elif state["responses"] == (1 if overlap else 2):
                state["timer"].callback()

        class Events(real_queue):
            def get(self, block=True, timeout=None):
                if block and self.empty():
                    pump()
                return super().get(block, min(timeout, 0.01) if timeout else timeout)

        def queues(maxsize):
            state["queues"] += 1
            return Events(maxsize) if state["queues"] == 1 else real_queue(maxsize)

        class Graph:
            paths = {"pw-record": "FAKE", "pw-play": "FAKE"}

            def bind(self, source, sink):
                return types.SimpleNamespace(name=source), object()

            def check(self):
                pass

        class Lock:
            def close(self):
                state["lock_closed"] = True

        class Sink:
            def __init__(self, *args):
                pass

            def write(self, pcm, current):
                return current()

            def drain(self, current):
                pass

            def health(self):
                pass

            def close(self):
                state["sink_closed"] = True

        class Speaker:
            def __init__(self, sink, emit):
                self.cv = threading.Condition(threading.RLock())
                self.active = self.saved = None
                state["speaker"] = self

            def play(self, pcm, kind, **kwargs):
                if pcm == b"RR":
                    state["responses"] += 1
                    self.active = {"kind": kind}

            def pause(self):
                if self.active:
                    state["interrupted"] = True
                    self.saved, self.active = self.active, None

            def discard(self):
                self.saved = None

            def close(self):
                state["speaker_closed"] = True

        real_gate, real_segments = continuous.InputReady, continuous.Segments

        def segments(*args):
            return real_segments(*args, clock=clock)

        def gate(receiver):
            state["gate"] = real_gate(receiver, clock=clock)
            return state["gate"]

        class Capture:
            def __init__(self, *args):
                self.receiver = args[-2]

            def start(self):
                state["capture_starts"] += 1
                for _ in range(160 if failure == "deadline" else 30):
                    now[0] += 0.032
                    self.receiver.feed(b"\0" * 1024, failure == "deadline", captured_at=clock())

            def wait_ready(self):
                if failure == "interrupt":
                    raise KeyboardInterrupt
                if failure == "readiness":
                    raise RuntimeError("fake readiness failure")

            def health(self):
                pass

            def close(self):
                state["capture_closed"] = True

        class Timer:
            def __init__(self, seconds, callback):
                self.callback = callback
                state["timer"] = self
                self.seconds = seconds

            def start(self):
                pass

            def cancel(self):
                state["timer_cancelled"] = True

            def join(self, timeout):
                pass

            def is_alive(self):
                return False

        def thread(**kwargs):
            instance = real_thread(**kwargs)
            state["threads"].append(instance)
            return instance

        def transcribe(pcm):
            index = state.get("decoded", 0)
            state["decoded"] = index + 1
            if overlap and index == 0:
                first_started.set()
                if not release.wait(1):
                    raise RuntimeError("fake overlap never arrived")
            return ("review the tests" if index == 0 else "focus on the failures"), 1

        inference = types.SimpleNamespace(
            rate=16000,
            np=types.SimpleNamespace(arange=lambda value: Vector(), hanning=lambda value: Vector(),
                                     sin=lambda value: Vector(), pi=3.14),
            synthesize=lambda text: b"RR" if text in (continuous.RESPONSE, "The fake answer is ready.") else b"AA",
            transcribe=transcribe,
        )
        class Agent:
            def start(self, receive, fault):
                self.receive = receive
                state["agent_fault"] = fault

            def arm(self, seconds):
                state["agent_armed"] = seconds

            def onset(self, generation):
                state.setdefault("agent_onsets", []).append(generation)

            def submit(self, generation, text):
                state.setdefault("agent_texts", []).append(text)
                self.receive({"type": "agent_answer", "generation": generation,
                              "text": "The fake answer is ready."})
                self.receive({"type": "agent_accepted", "sequence": len(state["agent_texts"])})

            def close(self):
                state["agent_closed"] = True

        agent = Agent() if agent_mode else None
        args = types.SimpleNamespace(input="internal", output="headphones", seconds=90,
                                     show_text=True, warmup_only=warmup_only)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, {"pysilero_vad":
                                types.SimpleNamespace(SileroVoiceActivityDetector=object)}))
            for target, name, replacement in (
                (devices, "Graph", Graph), (devices, "PipeSink", Sink), (cli, "AudioLock", Lock),
                (continuous, "LabCapture", Capture), (continuous, "Speaker", Speaker),
                (continuous, "Segments", segments), (continuous, "InputReady", gate),
                (continuous.queue, "Queue", queues), (continuous.threading, "Timer", Timer),
                (continuous.threading, "Thread", thread), (continuous.time, "monotonic", clock),
            ):
                stack.enter_context(patch.object(target, name, replacement))
            stack.enter_context(patch("builtins.input", return_value=""))
            stack.enter_context(contextlib.redirect_stdout(output))
            try:
                if failure:
                    expected = KeyboardInterrupt if failure == "interrupt" else RuntimeError
                    with self.assertRaises(expected):
                        continuous.trial(args, inference, agent)
                else:
                    continuous.trial(args, inference, agent)
            finally:
                release.set()
                for instance in state["threads"]:
                    instance.join(0.3)
        heard = [json.loads(line) for line in output.getvalue().splitlines()
                 if line.startswith('{"event": "heard"')]
        expected_text = (["review the tests"] if failure == "disconnect" else [] if failure or warmup_only
                         else ["review the tests", "focus on the failures"])
        self.assertEqual([row["text"] for row in heard], expected_text)
        self.assertTrue(all(row["dispatch"] == ("pending" if agent_mode else False) for row in heard))
        self.assertEqual(state["capture_starts"], 1)
        self.assertEqual(state["responses"], 1 if failure == "disconnect" else 0 if failure or warmup_only else (1 if overlap else 2))
        self.assertTrue(all(state.get(name) for name in
                            ("capture_closed", "speaker_closed", "sink_closed", "lock_closed", "timer_cancelled")))
        self.assertFalse(any(instance.is_alive() for instance in state["threads"]))
        if agent_mode:
            if not failure:
                self.assertIn('"agent_reply_received"', output.getvalue())
                self.assertIn('"agent_synthesis_complete"', output.getvalue())
                self.assertIn('"agent_playback_queued"', output.getvalue())
            self.assertTrue(state["agent_closed"])
            self.assertEqual(state.get("agent_texts", []), expected_text)
        if warmup_only:
            self.assertEqual(state.get("decoded", 0), 0)
            self.assertIn('"warmupDiagnostics"', output.getvalue())
            self.assertEqual(state["timer"].seconds, 6)
            return
        if failure:
            if failure in ("readiness", "deadline"):
                self.assertIn('"warmupFailure"', output.getvalue())
            if failure == "deadline":
                report = next(json.loads(line)["warmupFailure"] for line in output.getvalue().splitlines()
                              if line.startswith('{"warmupFailure"'))
                self.assertGreater(report["rejectedBuckets"]["vadSpeech"], 0)
                self.assertEqual(report["rejectedBuckets"]["clipping"], 0)
                self.assertGreaterEqual(report["elapsedSeconds"], 5)
            return
        if overlap:
            self.assertTrue(heard[0]["superseded"])
        else:
            self.assertTrue(state["interrupted"])
            self.assertIsNone(state["speaker"].saved)

    def test_continuous_capture_and_barge_in_keep_both_utterances(self):
        self.exercise()

    def test_addition_during_decode_preserves_text_and_suppresses_stale_reply(self):
        self.exercise(overlap=True)

    def test_real_agent_adapter_preserves_barge_and_decode_additions_without_live_provider(self):
        for overlap in (False, True):
            with self.subTest(overlap=overlap):
                self.exercise(overlap=overlap, agent_mode=True)

    def test_readiness_only_closes_after_warmup_without_transcribing(self):
        self.exercise(warmup_only=True)

    def test_agent_disconnect_closes_capture_without_another_utterance(self):
        self.exercise(agent_mode=True, failure="disconnect")

    def test_interrupt_and_readiness_failure_close_all_owned_audio(self):
        for failure in ("interrupt", "readiness", "deadline"):
            with self.subTest(failure=failure):
                self.exercise(failure=failure)


if __name__ == "__main__":
    unittest.main()
