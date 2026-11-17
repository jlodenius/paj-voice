import array
import contextlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

from paj_voice_audio import open_mic
from paj_voice_audio.devices import Child, Node


class Vector:
    def __len__(self):
        return 1600

    def __mul__(self, value):
        return self

    __rmul__ = __mul__
    __truediv__ = __mul__

    def astype(self, value):
        return self

    def tobytes(self):
        return b"\0\0" * 1600


def wait_for(predicate):
    deadline = time.monotonic() + 2
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("Timed out waiting for fake runtime")
        time.sleep(0.005)


class OpenMicTests(unittest.TestCase):
    def fixture(self, hold_load=False, capture_process=False):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        events, captures, played = [], [], []
        executable = root / 'dummy-recorder'
        executable.write_text(f'#!{sys.executable}\nimport time\nprint("READY", flush=True)\ntime.sleep(30)\n')
        executable.chmod(0o700)
        load_entered, release_load = threading.Event(), threading.Event()
        config = {"cacheDir": str(root / "cache"), "stt": {"model": "/fake/stt", "computeType": "int8"},
                  "tts": {"model": "/fake/voice", "config": "/fake/voice.json", "volume": 0.4, "lengthScale": 1},
                  "audio": {"input": "laptop", "output": "headphones"},
                  "turn": {"silenceMs": 800, "maxSeconds": 12, "speechThreshold": 0.001}}
        graph = types.SimpleNamespace(paths={"pw-record": "FAKE", "pw-play": "FAKE"},
                                      bind=lambda *args: (types.SimpleNamespace(name="laptop"), object()),
                                      check=Mock())
        models = types.SimpleNamespace(rate=16000, transcribe=Mock(return_value=("a request", 1)),
                                       synthesize=Mock(return_value=b"\0\0" * 1600),
                                       np=types.SimpleNamespace(arange=lambda size: Vector(), sin=lambda value: Vector(),
                                                                hanning=lambda size: Vector(), pi=3.14))

        def load(**kwargs):
            load_entered.set()
            if hold_load:
                release_load.wait(2)
            return models

        class Capture:
            def __init__(self, executable, node, vad, threshold, receiver, fail):
                self.receiver, self.closed = receiver, False
                self.child = None
                captures.append(self)

            def start(self):
                if capture_process:
                    self.child = Child(str(executable), Node('dummy', '999', 'Audio/Source'), 16000, True)
                    if self.child.process.stdout.readline() != b'READY\n':
                        raise RuntimeError('Dummy child did not reach its lifetime guard')
                for _ in range(3):
                    self.receiver.feed(b"\0\0" * 4000, False)

            def wait_ready(self):
                pass

            def health(self):
                pass

            def close(self):
                self.closed = True
                if self.child:
                    self.child.stop()

        class Sink:
            def __init__(self, *args):
                self.closed = False

            def health(self):
                pass

            def close(self):
                self.closed = True

        class Speaker:
            def __init__(self, sink, emit):
                self.paused = self.closed = False

            def play(self, pcm, kind, ident=None):
                if self.closed:
                    raise AssertionError("Playback after close")
                played.append(ident)

            def pause(self):
                self.paused = True

            def discard(self):
                pass

            def cancel(self):
                self.paused = True

            def close(self):
                self.closed = True

        for name, replacement in (("validate", lambda value: config), ("Graph", lambda: graph),
                                  ("SpeechInference", load), ("LabCapture", Capture),
                                  ("PipeSink", Sink), ("Speaker", Speaker)):
            stack.enter_context(patch.object(open_mic, name, replacement))
        stack.enter_context(patch.dict(sys.modules, {"pysilero_vad":
                            types.SimpleNamespace(SileroVoiceActivityDetector=object)}))
        runtime = open_mic.Runtime(events.append)
        self.addCleanup(runtime.shutdown)
        self.addCleanup(release_load.set)
        runtime.command({"type": "configure", "config": {}})
        self.assertTrue(load_entered.wait(1))
        if not hold_load:
            wait_for(lambda: runtime.ready and "ready" in played)
        return runtime, events, captures, played, models, graph, release_load

    def utterance(self, runtime, ident, pcm=b"\0\0" * 512):
        runtime._interrupt(runtime.epoch)
        runtime._segment({"type": "onset", "id": ident}, runtime.epoch)
        runtime._segment({"type": "endpoint", "id": ident, "pcm": pcm, "truncated": False}, runtime.epoch)

    def test_recurring_flat_dc_stops_input_without_filtering_normal_speech(self):
        receiver = Mock()
        healthy = open_mic.HealthyInput(receiver)
        speech = array.array("h", [32767, -32768] * 256).tobytes()
        healthy.feed(speech, True, captured_at=1)
        receiver.feed.assert_called_once_with(speech, True, captured_at=1)
        with self.assertRaisesRegex(RuntimeError, "flat clipping/DC"):
            healthy.feed(array.array("h", [-32768] * 512).tobytes(), False, captured_at=2)
        self.assertEqual(receiver.feed.call_count, 1)

    def test_packaged_models_and_open_mic_schema_have_no_wake_or_hint_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "stt").mkdir()
            (root / "tts").mkdir()
            for name in ("model.bin", "config.json", "tokenizer.json"):
                (root / "stt" / name).touch()
            (root / "tts/model.onnx").touch()
            (root / "tts/model.onnx.json").write_text(json.dumps({"language": {"code": "en_US"}}))
            base = {"version": 1, "cacheDir": str(root / "cache"),
                    "audio": {"input": "laptop", "output": "headphones", "echoCancellation": "none"}}
            with patch.dict("os.environ", {"PAJ_VOICE_SPEECH_BUNDLE": str(root)}):
                config = open_mic.validate(base)
                self.assertEqual(config["stt"]["model"], str(root / "stt"))
                self.assertEqual(config["turn"]["maxSeconds"], 12)
                for change in ({"addressPhrases": ["paj"]}, {"stt": {"hotwords": "pie"}},
                               {"turn": {"prefixIntervalMs": 500}}):
                    with self.assertRaises(ValueError):
                        open_mic.validate({**base, **change})
                (root / "stt/tokenizer.json").unlink()
                with self.assertRaises(ValueError):
                    open_mic.validate(base)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux child lifetime semantics')
    def test_capture_child_survives_loader_ready_boundary_until_shutdown(self):
        runtime, events, captures, *_ = self.fixture(capture_process=True)
        child = captures[0].child
        time.sleep(0.15)
        self.assertIsNone(child.process.poll(), 'Recorder died when its creating loader thread returned')
        runtime.shutdown()
        self.assertIsNotNone(child.process.poll())

    def test_ready_requires_warmup_then_capture_stays_open_without_a_trial_timer(self):
        runtime, events, captures, played, *_ = self.fixture()
        self.assertEqual(len(captures), 1)
        ready = next(event for event in events if event["type"] == "ready")
        self.assertEqual(ready["mode"], "open-mic")
        self.assertEqual(ready["warmup"]["stableQuietSeconds"], 0.75)
        self.assertEqual(played, ["ready"])
        self.assertFalse(captures[0].closed)
        runtime.shutdown()
        self.assertTrue(captures[0].closed)

    def test_bare_commands_and_decode_additions_are_preserved_without_wake_words(self):
        runtime, events, _, _, models, *_ = self.fixture()
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        count = [0]

        def transcribe(pcm):
            count[0] += 1
            if count[0] == 1:
                started.set()
                release.wait(1)
                return "inspect the tests", 1
            return "focus on the failing ones", 1

        models.transcribe.side_effect = transcribe
        self.utterance(runtime, 1)
        self.assertTrue(started.wait(1))
        self.utterance(runtime, 2)
        self.assertTrue(runtime.speaker.paused)
        release.set()
        wait_for(lambda: len([e for e in events if e["type"] == "utterance"]) == 2)
        self.assertEqual([e["text"] for e in events if e["type"] == "utterance"],
                         ["inspect the tests", "focus on the failing ones"])
        self.assertFalse(runtime.pending)

    def test_new_speech_discards_inflight_synthesis_without_cancelling_capture(self):
        runtime, events, captures, played, models, *_ = self.fixture()
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def synthesize(text):
            started.set()
            release.wait(1)
            return b"\0\0" * 1024

        models.synthesize.side_effect = synthesize
        runtime.command({"type": "speak", "id": "old", "text": "An old answer."})
        self.assertTrue(started.wait(1))
        runtime._interrupt(runtime.epoch)
        runtime._segment({"type": "onset", "id": 1}, runtime.epoch)
        release.set()
        wait_for(lambda: any(e["type"] == "speech_end" and e["id"] == "old" for e in events))
        self.assertNotIn("old", played)
        self.assertFalse(captures[0].closed)
        ended = next(e for e in events if e["type"] == "speech_end" and e["id"] == "old")
        self.assertIs(ended.get("completed"), False)

    def test_normal_speech_waits_for_prior_playback_instead_of_cutting_it_off(self):
        runtime, events, _, played, *_ = self.fixture()
        runtime.command({"type": "speak", "id": "one", "text": "First sentence."})
        wait_for(lambda: "one" in played)
        runtime.command({"type": "speak", "id": "two", "text": "Second sentence."})
        time.sleep(0.03)
        self.assertNotIn("two", played)
        runtime._speaker_event({"type": "played", "id": "one"})
        ended = next(e for e in events if e["type"] == "speech_end" and e["id"] == "one")
        self.assertIs(ended.get("completed"), True)
        wait_for(lambda: "two" in played)

    def test_keyed_updates_coalesce_queued_and_inflight_speech(self):
        runtime, events, _, played, models, *_ = self.fixture()
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def synthesize(text):
            if text == "Old progress.":
                entered.set()
                release.wait(1)
            return b"\0\0" * 1024

        models.synthesize.side_effect = synthesize
        runtime.command({"type": "speak", "id": "old", "text": "Old progress.", "key": "progress"})
        self.assertTrue(entered.wait(1))
        runtime.command({"type": "speak", "id": "interim", "text": "Interim progress.", "key": "progress"})
        runtime.command({"type": "speak", "id": "latest", "text": "Current progress.", "key": "progress"})
        release.set()
        wait_for(lambda: "latest" in played)
        self.assertNotIn("old", played)
        self.assertNotIn("interim", played)

    def test_shutdown_or_mute_during_model_loading_never_opens_a_late_microphone(self):
        for action in ("shutdown", "mute"):
            with self.subTest(action=action):
                runtime, events, captures, _, _, _, release = self.fixture(hold_load=True)
                runtime.command({"type": action, **({"muted": True} if action == "mute" else {})})
                release.set()
                time.sleep(0.03)
                self.assertFalse(captures)
                self.assertFalse(any(event["type"] == "ready" for event in events))
                runtime.shutdown()

    def test_mute_failure_and_eof_style_shutdown_close_all_owned_audio(self):
        runtime, events, captures, *_ = self.fixture()
        speaker, sink = runtime.speaker, runtime.sink
        runtime.command({"type": "mute", "muted": True})
        self.assertTrue(captures[0].closed)
        self.assertFalse(runtime.ready)
        runtime.fail(RuntimeError("fake device loss"))
        runtime.fail(RuntimeError("again"))
        self.assertTrue(runtime.closed)
        self.assertTrue(speaker.closed and sink.closed)
        self.assertEqual(sum(e["type"] == "error" for e in events), 1)


if __name__ == "__main__":
    unittest.main()
