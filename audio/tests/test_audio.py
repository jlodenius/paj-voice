import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from paj_voice_audio.cli import AudioLock, Protocol, serve
from paj_voice_audio.core import Playback, Turns, prefix
from paj_voice_audio.devices import Node
from paj_voice_audio.runtime import Runtime, validate

SETTINGS = {
    "silenceMs": 300,
    "maxSeconds": 5,
    "prefixIntervalMs": 500,
    "speechThreshold": 0.01,
}


class Sink:
    def __init__(self, events):
        self.events = events
        self.written = []

    def abort(self):
        self.events.append({"type": "local_stop"})

    def write(self, chunk, current):
        if current():
            self.written.append(chunk)
            return True
        return False

    def drain(self, current):
        pass


class PrefixTests(unittest.TestCase):
    def test_exact_normalized_prefix_and_alias(self):
        self.assertEqual(
            prefix("“PODGE,” add a test.", ["paj", "podge"]), ("podge", "add a test.")
        )
        self.assertEqual(
            prefix("Hey, Paj! do it", ["paj", "hey paj"]), ("hey paj", "do it")
        )

    def test_nonprefix_substrings_numbers_and_contractions_rejected(self):
        for text in (
            "turn the page",
            "pajama",
            "not paj",
            "123 paj",
            "paj's task",
            "é paj",
        ):
            self.assertEqual(prefix(text, ["paj"]), (None, ""))

    def test_paj_phonetic_spellings_never_admit_hi_or_mid_sentence_pie(self):
        phrases = ["paj", "pie", "pi"]
        for spelling in phrases:
            self.assertEqual(
                prefix(f"{spelling}, check the tests.", phrases),
                (spelling, "check the tests."),
            )
        for text in (
            "Hi, check the tests.",
            "High, check the tests.",
            "The pie is ready.",
            "I said pi.",
        ):
            self.assertEqual(prefix(text, phrases), (None, ""))

    def test_bare_prefix_with_unicode_punctuation(self):
        self.assertEqual(prefix("“Paj…”", ["paj"]), ("paj", ""))


class TurnTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.errors = []
        self.playback = Mock()
        self.playback.stop.side_effect = lambda: self.events.append(
            {"type": "local_stop"}
        )
        self.now = [10.0]
        self.turns = Turns(
            SETTINGS,
            ["paj", "podge"],
            lambda pcm: "",
            self.playback,
            self.events.append,
            self.errors.append,
            clock=lambda: self.now[0],
            start_worker=False,
        )
        self.addCleanup(self.turns.close)

    def begin(self):
        self.turns.feed(b"\1\0" * 16000, True)
        return self.turns.current

    def end(self):
        self.turns.feed(b"\0\0" * 4800, False)

    def test_stop_precedes_address_and_only_final_submits(self):
        turn = self.begin()
        self.turns.result(turn, "Paj, change it", False)
        self.assertEqual(self.events, [])
        self.turns.result(turn, "Paj, change the test", False)
        self.assertEqual([e["type"] for e in self.events], ["local_stop", "addressed"])
        self.end()
        self.turns.result(turn, "Paj, change the test", True)
        self.assertEqual(turn.pcm, b"")
        self.assertEqual(
            self.events[-1],
            {"type": "utterance", "id": turn.id, "text": "change the test"},
        )
        self.turns.result(turn, "Paj, duplicate", True)
        self.assertEqual(len(self.events), 3)

    def test_final_can_address_without_partial(self):
        turn = self.begin()
        self.end()
        self.turns.result(turn, "Podge do it", True)
        self.assertEqual(
            [e["type"] for e in self.events], ["local_stop", "addressed", "utterance"]
        )

    def test_address_discards_queued_partial_for_same_turn(self):
        turn = self.begin()
        self.assertIs(self.turns.partial[0], turn)
        self.turns.result(turn, "Paj stop talking", False)
        self.assertIsNotNone(self.turns.partial)
        self.turns.result(turn, "Paj stop talking", False)
        self.assertIsNone(self.turns.partial)
        self.end()
        self.turns.result(turn, "Hi stop talking", True)
        self.assertEqual(self.events[-1]["type"], "cancelled")
        self.assertFalse(any(event["type"] == "utterance" for event in self.events))

    def test_address_preserves_another_turns_queued_partial(self):
        first = self.begin()
        self.end()
        second = self.begin()
        pending = self.turns.partial
        self.assertIs(pending[0], second)
        self.turns.result(first, "Paj first request", True)
        self.assertIs(self.turns.partial, pending)
        self.assertEqual(self.events[-1]["text"], "first request")

    def test_unaddressed_never_leaves_process(self):
        turn = self.begin()
        self.end()
        self.turns.result(turn, "the game said paj", True)
        self.assertEqual(self.events, [])

    def test_bare_prefix_is_cancelled(self):
        turn = self.begin()
        self.end()
        self.turns.result(turn, "Paj...", True)
        self.assertEqual(
            [e["type"] for e in self.events], ["local_stop", "addressed", "cancelled"]
        )

    def test_withdrawn_prefix_is_cancelled(self):
        turn = self.begin()
        self.turns.result(turn, "paj hello", False)
        self.turns.result(turn, "paj hello", False)
        self.end()
        self.turns.result(turn, "page hello", True)
        self.assertEqual(self.events[-1]["type"], "cancelled")
        self.assertFalse(any(e["type"] == "utterance" for e in self.events))

    def test_inconsistent_partial_resets_confirmations(self):
        turn = self.begin()
        for text in ("paj hello", "page hello", "paj hello"):
            self.turns.result(turn, text, False)
        self.assertEqual(self.events, [])

    def test_partial_finishing_after_endpoint_is_ignored(self):
        turn = self.begin()
        self.end()
        self.turns.result(turn, "paj hello", False)
        self.turns.result(turn, "paj hello", False)
        self.assertEqual(self.events, [])

    def test_mute_clears_audio_and_invalidates_inflight_result(self):
        turn = self.begin()
        self.end()
        self.turns.reset(True)
        self.assertEqual(turn.pcm, b"")
        self.assertFalse(self.turns.turns or self.turns.finals or self.turns.preroll)
        self.assertIsNone(self.turns.partial)
        self.turns.feed(b"\1\0" * 16000, True)
        self.assertIsNone(self.turns.current)
        self.turns.reset(False)
        self.turns.result(turn, "paj stale", True)
        self.assertEqual(self.events, [])

    def test_quiet_address_survives_delayed_voice_detection(self):
        silence = b"\0\0" * 512
        address = b"\x15\0" * 512
        body = b"\x22\0" * 512
        for _ in range(16):
            self.turns.feed(silence, False)
        for _ in range(4):
            self.turns.feed(address, False)
        for _ in range(16):
            self.turns.feed(silence, False)
        self.turns.feed(body, True)
        turn = self.turns.current
        self.assertIn(address * 4, turn.pcm)
        self.assertTrue(turn.pcm.endswith(body))
        self.assertLessEqual(len(turn.pcm), 32000 + len(body))

    def test_preroll_and_partial_snapshot_bounded(self):
        for _ in range(20):
            self.turns.feed(b"\0\0" * 1600, False)
        self.assertEqual(self.turns.preroll_bytes, 32000)
        turn = self.begin()
        self.assertEqual(len(turn.pcm), 64000)
        self.turns.feed(b"\1\0" * 48000, True)
        self.assertLessEqual(len(self.turns.partial[1]), 128000)

    def test_long_turn_fails_without_truncated_submission(self):
        self.begin()
        with self.assertRaisesRegex(RuntimeError, "Maximum turn"):
            self.turns.feed(b"\1\0" * 80000, True)
        self.assertEqual(self.events, [])

    def test_recognition_backlog_is_bounded(self):
        for _ in range(3):
            self.begin()
            self.end()
        with self.assertRaisesRegex(RuntimeError, "fell behind"):
            self.begin()

    def test_stale_final_and_inference_watchdog(self):
        turn = self.begin()
        self.end()
        self.now[0] += 9
        with self.assertRaisesRegex(RuntimeError, "stale"):
            self.turns.result(turn, "paj do it", True)
        self.turns.busy_since = self.now[0] - 11
        with self.assertRaisesRegex(RuntimeError, "latency"):
            self.turns.health()
        self.assertEqual(self.events, [])

    def test_provider_failure_is_reported(self):
        failed = threading.Event()
        turns = Turns(
            SETTINGS,
            ["paj"],
            Mock(side_effect=RuntimeError("ASR failed")),
            self.playback,
            self.events.append,
            lambda error: failed.set(),
        )
        self.addCleanup(turns.close)
        turns.feed(b"\1\0" * 16000, True)
        self.assertTrue(failed.wait(1))


class PlaybackTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.errors = []
        self.sink = Sink(self.events)

    def player(self, synthesize=lambda text: iter([b"sound"]), **kwargs):
        player = Playback(
            synthesize, self.sink, self.events.append, self.errors.append, **kwargs
        )
        self.addCleanup(player.close)
        return player

    def test_key_replacement_queue_limit_and_deduplication(self):
        player = self.player(limit=2, start_worker=False)
        player.enqueue({"id": "one", "text": "one", "key": "progress"})
        player.enqueue({"id": "two", "text": "two", "key": "progress"})
        self.assertEqual([item["id"] for item in player.queue], ["two"])
        player.enqueue({"id": "three", "text": "three"})
        with self.assertRaisesRegex(RuntimeError, "queue limit"):
            player.enqueue({"id": "four", "text": "four"})
        self.assertFalse(player.enqueue({"id": "three", "text": "three"}))
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            player.enqueue({"id": "three", "text": "different"})

    def test_urgent_clears_previous_queue(self):
        player = self.player(start_worker=False)
        player.enqueue({"id": "one", "text": "one"})
        player.enqueue({"id": "two", "text": "two", "priority": "urgent"})
        self.assertEqual([item["id"] for item in player.queue], ["two"])
        self.assertEqual(self.events[0]["type"], "local_stop")

    def test_stopped_inflight_synthesis_cannot_write_audio(self):
        started, release, finished = (
            threading.Event(),
            threading.Event(),
            threading.Event(),
        )

        def synthesize(text):
            started.set()
            release.wait(1)
            try:
                yield b"stale"
            finally:
                finished.set()

        player = self.player(synthesize)
        player.enqueue({"id": "one", "text": "one"})
        self.assertTrue(started.wait(1))
        player.stop()
        release.set()
        self.assertTrue(finished.wait(1))
        self.assertEqual(self.sink.written, [])
        self.assertFalse(any(event["type"] == "speech_start" for event in self.events))

    def test_stop_active_speech_emits_single_end(self):
        first, release, finished = (
            threading.Event(),
            threading.Event(),
            threading.Event(),
        )

        def synthesize(text):
            yield b"first"
            first.set()
            release.wait(1)
            try:
                yield b"stale"
            finally:
                finished.set()

        player = self.player(synthesize)
        player.enqueue({"id": "one", "text": "one"})
        self.assertTrue(first.wait(1))
        player.stop()
        player.stop()
        release.set()
        self.assertTrue(finished.wait(1))
        self.assertEqual(self.sink.written, [b"first"])
        self.assertEqual(sum(e["type"] == "speech_end" for e in self.events), 1)

    def test_synthesis_failure_is_reported(self):
        failed = threading.Event()
        player = Playback(
            Mock(side_effect=RuntimeError("TTS failed")),
            self.sink,
            self.events.append,
            lambda error: failed.set(),
        )
        self.addCleanup(player.close)
        player.enqueue({"id": "one", "text": "one"})
        self.assertTrue(failed.wait(1))

    def test_invalid_speech_rejected_and_synthesis_timeout(self):
        player = self.player(start_worker=False)
        for frame in (
            {"id": "invalid id", "text": "hi"},
            {"id": "ok", "text": "x" * 321},
            {"id": "ok", "text": "line\nbreak"},
        ):
            with self.assertRaises(ValueError):
                player.enqueue(frame)
        player.synthesis_since = time.monotonic() - 16
        with self.assertRaisesRegex(RuntimeError, "latency"):
            player.health()


class RuntimeTests(unittest.TestCase):
    def test_ready_requires_pcm_and_load_failure_never_emits_ready(self):
        config = {
            "stt": {"model": "/local/stt", "computeType": "int8", "hotwords": "pie"},
            "tts": {"model": "/local/voice.onnx", "config": "/local/voice.json"},
            "audio": {"input": "paj_voice_source", "output": "paj_voice_sink"},
            "turn": SETTINGS,
            "addressPhrases": ["paj"],
        }
        for broken_capture in (False, True):
            with self.subTest(broken_capture=broken_capture):
                events = []
                pcm, done = threading.Event(), threading.Event()

                def emit(frame):
                    events.append(frame)
                    if frame["type"] in ("ready", "error"):
                        done.set()

                runtime = Runtime(emit)
                whisper, piper, graph, capture = Mock(), Mock(), Mock(), Mock()
                whisper.return_value.supported_languages = ["en"]
                whisper.return_value.transcribe.return_value = ([], None)
                piper.load.return_value.config.sample_rate = 22050
                graph.paths = {"pw-record": "/bin/pw-record", "pw-play": "/bin/pw-play"}
                graph.bind.return_value = (
                    Node("paj_voice_source", "10", "Audio/Source"),
                    Node("paj_voice_sink", "11", "Audio/Sink"),
                )

                def wait_ready():
                    if broken_capture:
                        raise RuntimeError("Capture cannot produce PCM")
                    pcm.wait(1)
                    events.append({"type": "pcm_received"})

                capture.wait_ready.side_effect = wait_ready
                runtime._capture = Mock(return_value=capture)
                modules = {
                    "numpy": MagicMock(),
                    "faster_whisper": types.SimpleNamespace(WhisperModel=whisper),
                    "piper": types.SimpleNamespace(PiperVoice=piper),
                    "pysilero_vad": types.SimpleNamespace(
                        SileroVoiceActivityDetector=Mock()
                    ),
                }
                with (
                    patch.dict(sys.modules, modules),
                    patch("paj_voice_audio.runtime.validate", return_value=config),
                    patch("paj_voice_audio.runtime.Graph", return_value=graph),
                ):
                    runtime._load(config)
                    if not broken_capture:
                        runtime.turns.transcribe(b"\0" * 1024)
                        self.assertEqual(
                            whisper.return_value.transcribe.call_args.kwargs[
                                "hotwords"
                            ],
                            "pie",
                        )
                        self.assertFalse(runtime.ready)
                        runtime.command(
                            {"type": "stop"}
                        ) if runtime.configured else None
                        pcm.set()
                    self.assertTrue(done.wait(1))
                whisper.assert_called_once_with(
                    "/local/stt",
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=2,
                    num_workers=1,
                    local_files_only=True,
                )
                if broken_capture:
                    self.assertEqual([event["type"] for event in events], ["error"])
                    self.assertTrue(runtime.closed)
                else:
                    self.assertEqual(
                        [event["type"] for event in events], ["pcm_received", "ready"]
                    )
                    self.assertTrue(runtime.ready)
                    self.assertEqual(runtime.sink.rate, 22050)
                runtime.shutdown()

    def test_unsupported_recognition_language_fails_before_capture_or_tts(self):
        events = []
        runtime = Runtime(events.append)
        whisper = Mock(return_value=types.SimpleNamespace(supported_languages=["sv"]))
        piper, graph = Mock(), Mock()
        graph.bind.return_value = (Mock(), Mock())
        config = {
            "stt": {"model": "/local/stt", "computeType": "int8"},
            "audio": {"input": "source", "output": "sink"},
        }
        modules = {
            "numpy": Mock(),
            "faster_whisper": types.SimpleNamespace(WhisperModel=whisper),
            "piper": types.SimpleNamespace(PiperVoice=piper),
            "pysilero_vad": types.SimpleNamespace(SileroVoiceActivityDetector=Mock()),
        }
        with (
            patch.dict(sys.modules, modules),
            patch("paj_voice_audio.runtime.validate", return_value=config),
            patch("paj_voice_audio.runtime.Graph", return_value=graph),
        ):
            runtime._load(config)
        self.assertTrue(runtime.closed)
        self.assertIsNone(runtime.capture)
        self.assertIn("English", events[0]["message"])
        piper.load.assert_not_called()

    def test_loading_does_not_block_control_or_eof(self):
        runtime = Runtime(lambda event: None)
        entered, release = threading.Event(), threading.Event()

        def load(config):
            entered.set()
            release.wait(1)

        runtime._load = load
        runtime.command({"type": "configure", "config": {}})
        self.assertTrue(entered.wait(1))
        runtime.command({"type": "mute", "muted": True})
        self.assertTrue(runtime.muted)
        runtime.command({"type": "stop"})
        runtime.shutdown()
        release.set()
        self.assertTrue(runtime.closed)

    def test_mute_closes_capture_and_unmute_reopens_exact_source(self):
        runtime = Runtime(lambda event: None)
        runtime.ready, runtime.configured, runtime.loaded = True, True, True
        runtime.capture, runtime.playback, runtime.turns = Mock(), Mock(), Mock()
        old = runtime.capture
        fresh = Mock()
        unmuted = threading.Event()
        runtime.turns.reset.side_effect = lambda muted: (
            unmuted.set() if not muted else None
        )
        runtime._capture = Mock(return_value=fresh)
        runtime.command({"type": "mute", "muted": True})
        old.close.assert_called_once()
        runtime.turns.reset.assert_called_with(True)
        runtime.playback.stop.assert_called_once()
        self.assertIsNone(runtime.capture)
        runtime.command({"type": "mute", "muted": False})
        self.assertTrue(unmuted.wait(1))
        runtime.turns.reset.assert_called_with(False)
        self.assertIs(runtime.capture, fresh)
        runtime.shutdown()

    def test_failure_emitted_once_and_all_audio_closed(self):
        events = []
        runtime = Runtime(events.append)
        runtime.capture, runtime.playback, runtime.turns, runtime.sink = (
            Mock(),
            Mock(),
            Mock(),
            Mock(),
        )
        capture = runtime.capture
        runtime.fail(RuntimeError("device gone"))
        runtime.fail(RuntimeError("again"))
        self.assertEqual(events, [{"type": "error", "message": "device gone"}])
        self.assertTrue(runtime.closed)
        capture.close.assert_called_once()
        runtime.playback.close.assert_called_once()
        runtime.turns.close.assert_called_once()
        runtime.sink.close.assert_called_once()

    def test_local_model_validation_never_falls_back_to_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for asset in (
                "model.bin",
                "config.json",
                "tokenizer.json",
                "vocabulary.txt",
                "voice.onnx",
                "voice.json",
            ):
                (root / asset).touch()
            config = {
                "version": 1,
                "languages": ["en"],
                "responseLanguage": "en",
                "addressPhrases": ["paj"],
                "stt": {"model": str(root), "computeType": "int8"},
                "tts": {
                    "model": str(root / "voice.onnx"),
                    "config": str(root / "voice.json"),
                },
                "audio": {
                    "input": "Paj mic",
                    "output": "Paj speaker",
                    "echoCancellation": "external",
                },
                "turn": SETTINGS.copy(),
            }
            voice = root / "voice.json"
            voice.write_text(json.dumps({"language": {"code": "en_US"}}))
            self.assertIs(validate(config), config)
            for hint in ("", 3, "pie\nignore", "x" * 257):
                config["stt"]["hotwords"] = hint
                with self.assertRaisesRegex(ValueError, "hotwords"):
                    validate(config)
            config["stt"]["hotwords"] = "pie"
            self.assertIs(validate(config), config)
            voice.write_text(json.dumps({"language": {"code": "sv_SE"}}))
            with self.assertRaisesRegex(ValueError, "English Piper"):
                validate(config)
            voice.write_text(json.dumps({"espeak": {"voice": "en-us"}}))
            self.assertIs(validate(config), config)
            voice.write_text("{}")
            with self.assertRaisesRegex(ValueError, "English Piper"):
                validate(config)
            (root / "tokenizer.json").unlink()
            with self.assertRaisesRegex(ValueError, "tokenizer"):
                validate(config)


class PipeTests(unittest.TestCase):
    class FakeRuntime:
        def __init__(self, emit):
            self.emit, self.closed, self.failed = emit, False, False
            self.commands = []
            self.shutdowns = 0

        def command(self, frame):
            self.commands.append(frame)
            if frame["type"] == "shutdown":
                self.closed = True

        def fail(self, error):
            self.failed = True
            self.emit({"type": "error", "message": str(error)})

        def shutdown(self):
            self.closed = True
            self.shutdowns += 1

    def run_pipe(self, source):
        events, runtimes = [], []

        def factory(emit):
            runtime = self.FakeRuntime(emit)
            runtimes.append(runtime)
            return runtime

        status = serve(io.StringIO(source), events.append, factory)
        return status, events, runtimes[0]

    def test_eof_shutdown_and_json_commands(self):
        status, events, runtime = self.run_pipe('{"type":"stop"}\n')
        self.assertEqual(status, 0)
        self.assertEqual(events, [])
        self.assertEqual(runtime.commands, [{"type": "stop"}])
        self.assertTrue(runtime.closed)
        self.assertEqual(runtime.shutdowns, 1)

    def test_invalid_oversized_nonfinite_and_truncated_lines(self):
        for source in (
            "[]\n",
            "{bad}\n",
            '{"type":"stop"}',
            '{"type":"stop","x":NaN}\n',
            "x" * 65537 + "\n",
        ):
            status, events, runtime = self.run_pipe(source)
            self.assertEqual(status, 1)
            self.assertTrue(runtime.closed)
            self.assertEqual(events[0]["type"], "error")

    def test_transport_failure_shuts_down_with_input_still_open(self):
        released = threading.Event()
        source = Mock()
        source.readline.side_effect = lambda size: released.wait(1) and ""
        runtime = self.FakeRuntime(lambda event: None)
        try:
            self.assertEqual(
                serve(
                    source,
                    lambda event: None,
                    lambda emit: runtime,
                    transport_ok=lambda: False,
                ),
                1,
            )
            self.assertTrue(runtime.closed)
        finally:
            released.set()

    def test_invalid_config_process_exits_without_closing_parent_input(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {
                **os.environ,
                "XDG_RUNTIME_DIR": directory,
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            process = subprocess.Popen(
                [sys.executable, "-m", "paj_voice_audio"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            try:
                process.stdin.write(
                    '{"type":"configure","generation":"test","config":{}}\n'
                )
                process.stdin.flush()
                self.assertEqual(process.wait(timeout=3), 1)
                frames = [
                    json.loads(line) for line in process.stdout.read().splitlines()
                ]
                self.assertEqual([frame["type"] for frame in frames], ["error"])
            finally:
                process.kill() if process.poll() is None else None
                process.communicate(timeout=3)

    def test_protocol_only_complete_ndjson(self):
        output = io.StringIO()
        protocol = Protocol(output)
        protocol.emit({"type": "ready"})
        protocol.emit({"type": "cancelled", "id": "one"})
        with self.assertRaisesRegex(RuntimeError, "line limit"):
            protocol.emit({"type": "error", "message": "é" * 16384})
        protocol.close()
        self.assertEqual(
            [json.loads(line)["type"] for line in output.getvalue().splitlines()],
            ["ready", "cancelled"],
        )

    def test_lock_excludes_other_session_and_rejects_unsafe_directory(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"XDG_RUNTIME_DIR": directory}),
        ):
            first = AudioLock()
            try:
                with self.assertRaisesRegex(RuntimeError, "owns audio"):
                    AudioLock()
            finally:
                first.close()
            second = AudioLock()
            second.close()
            os.chmod(directory, 0o755)
            with self.assertRaisesRegex(RuntimeError, "0700"):
                AudioLock()


if __name__ == "__main__":
    unittest.main()
