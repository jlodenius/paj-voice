import contextlib
import io
import json
import os
import queue
import subprocess
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from paj_voice_audio.cli import main
from paj_voice_audio.devices import (
    Child,
    Graph,
    Node,
    PipeCapture,
    PipeSink,
    child_exec,
    command_paths,
    select_node,
)

SOURCE = Node("paj_voice_source", "31", "Audio/Source")
SINK = Node("paj_voice_sink", "32", "Audio/Sink")
PATHS = {name: "/bin/" + name for name in ("pw-record", "pw-play", "pw-dump")}


def entry(node):
    return {
        "type": "PipeWire:Interface:Node",
        "info": {
            "state": "running",
            "props": {
                "node.name": node.name,
                "object.serial": node.serial,
                "media.class": node.kind,
            },
        },
    }


class Vad:
    def chunk_bytes(self):
        return 1024

    def __call__(self, frame):
        if len(frame) != self.chunk_bytes():
            raise ValueError("Wrong VAD frame size")
        return 0


class GraphTests(unittest.TestCase):
    def graph(self, entries=None):
        run = Mock(
            return_value=SimpleNamespace(
                stdout=json.dumps(entries or [entry(SOURCE), entry(SINK)])
            )
        )
        return Graph(paths=PATHS, run=run)

    def test_exact_name_class_serial_and_monitor_rejection(self):
        entries = [entry(SOURCE), entry(SINK)]
        self.assertEqual(select_node(entries, SOURCE.name, SOURCE.kind), SOURCE)
        for name in ("default", "auto", "0", "@DEFAULT_AUDIO_SOURCE@", "paj_monitor"):
            with self.assertRaises(ValueError):
                select_node(entries, name, SOURCE.kind)
        with self.assertRaisesRegex(RuntimeError, "exactly once"):
            select_node(entries * 2, SOURCE.name, SOURCE.kind)
        with self.assertRaisesRegex(RuntimeError, "media.class"):
            select_node(entries, SINK.name, SOURCE.kind)
        entries[0]["info"]["props"]["object.serial"] = ""
        with self.assertRaisesRegex(RuntimeError, "serial"):
            select_node(entries, SOURCE.name, SOURCE.kind)

    def test_bound_target_loss_and_same_name_replacement_fail(self):
        graph = self.graph()
        self.assertEqual(graph.bind(SOURCE.name, SINK.name), (SOURCE, SINK))
        graph.check()
        graph.run.return_value.stdout = json.dumps([entry(SINK)])
        with self.assertRaisesRegex(RuntimeError, "exactly once"):
            graph.check()
        replacement = entry(SOURCE)
        replacement["info"]["props"]["object.serial"] = "99"
        graph.run.return_value.stdout = json.dumps([replacement, entry(SINK)])
        with self.assertRaisesRegex(RuntimeError, "replaced"):
            graph.check()

    def test_devices_only_uses_pw_dump_and_never_opens_audio(self):
        graph = self.graph()
        output = io.StringIO()
        with (
            patch("paj_voice_audio.devices.Graph", return_value=graph),
            patch.object(sys, "argv", ["paj-voice-audio", "--devices"]),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(main(), 0)
        devices = json.loads(output.getvalue())
        self.assertEqual([item["name"] for item in devices], [SOURCE.name, SINK.name])
        graph.run.assert_called_once_with(
            [PATHS["pw-dump"], "--no-colors"],
            capture_output=True,
            check=True,
            timeout=3,
        )

    def test_missing_commands_and_graph_error_are_actionable(self):
        with patch("paj_voice_audio.devices.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Install PipeWire.*pw-record"):
                command_paths()
        graph = self.graph()
        graph.run.side_effect = subprocess.TimeoutExpired("pw-dump", 3)
        with self.assertRaisesRegex(RuntimeError, "pw-dump"):
            graph.snapshot()
        bad = entry(SOURCE)
        bad["info"]["state"] = "error"
        with self.assertRaisesRegex(RuntimeError, "error state"):
            select_node([bad], SOURCE.name, SOURCE.kind)


class ChildTests(unittest.TestCase):
    def process(self, diagnostic=b""):
        process = Mock()
        process.stdin = Mock()
        process.stdin.fileno.return_value = 123
        process.stdout = None
        process.stderr = io.BytesIO(diagnostic)
        process.poll.return_value = None
        return process

    def spawn(self, process, capture=False):
        with (
            patch(
                "paj_voice_audio.devices.subprocess.Popen", return_value=process
            ) as popen,
            patch("paj_voice_audio.devices.os.set_blocking"),
            patch("paj_voice_audio.devices.fcntl.fcntl", return_value=8192),
        ):
            child = Child(
                PATHS["pw-record"] if capture else PATHS["pw-play"],
                SOURCE if capture else SINK,
                16000,
                capture,
            )
        child.stderr_thread.join(timeout=1)
        return child, popen

    def test_serial_pinned_raw_args_and_no_fallback(self):
        process = self.process()
        child, popen = self.spawn(process)
        args = popen.call_args.args[0]
        self.assertEqual(args[:3], [sys.executable, "-P", "-m"])
        native = args[args.index(PATHS["pw-play"]) :]
        self.assertEqual(native[native.index("--target") + 1], SINK.serial)
        self.assertEqual(native[native.index("--rate") + 1], "16000")
        self.assertEqual(native[native.index("--format") + 1], "s16")
        self.assertIn("--raw", native)
        properties = json.loads(native[native.index("--properties") + 1])
        self.assertIs(properties["node.dont-fallback"], True)
        self.assertIs(properties["node.dont-reconnect"], True)
        self.assertIn("--child", args)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        child.stop()
        process.terminate.assert_called_once()
        process.wait.assert_called()

    def test_kill_escalation_reaps_and_discontinuity_fails(self):
        process = self.process(b"audio XRUN detected")
        process.wait.side_effect = [subprocess.TimeoutExpired("pw-play", 0.3), -9]
        child, _ = self.spawn(process)
        with self.assertRaisesRegex(RuntimeError, "discontinuity"):
            child.health()
        child.stop()
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)
        child.stop()
        process.kill.assert_called_once()

    def test_parent_death_guard_checks_before_and_after_prctl(self):
        libc = Mock()
        libc.prctl.return_value = 0
        with (
            patch("paj_voice_audio.devices.ctypes.CDLL", return_value=libc),
            patch("paj_voice_audio.devices.os.getppid", side_effect=[10, 11]),
            patch("paj_voice_audio.devices.os.execv") as execute,
        ):
            self.assertEqual(child_exec(10, ["/bin/true"]), 1)
            libc.prctl.assert_called_once()
            execute.assert_not_called()
        with (
            patch("paj_voice_audio.devices.os.getppid", return_value=11),
            patch("paj_voice_audio.devices.os.execv") as execute,
        ):
            self.assertEqual(child_exec(10, ["/bin/true"]), 1)
            execute.assert_not_called()


class SinkTests(unittest.TestCase):
    def sink(self):
        child = Mock()
        child.process.stdin.fileno.return_value = 123
        child.process.poll.return_value = None
        launch = Mock(return_value=child)
        sink = PipeSink(PATHS["pw-play"], SINK, 22050, launch=launch)
        self.addCleanup(sink.close)
        return sink, child, launch

    def test_lazy_playback_and_normal_drain(self):
        sink, child, launch = self.sink()
        launch.assert_not_called()
        with patch("paj_voice_audio.devices.os.write", return_value=4):
            self.assertTrue(sink.write(b"\0" * 4, lambda: True))
        launch.assert_called_once_with(PATHS["pw-play"], SINK, 22050, False)
        child.process.poll.side_effect = [None, 0]
        with patch("paj_voice_audio.devices.time.sleep"):
            sink.drain(lambda: True)
        child.process.stdin.close.assert_called_once()
        child.stop.assert_called_once()
        self.assertIsNone(sink.child)

    def test_abort_before_launch_and_during_backpressure_discards_stale_pcm(self):
        sink, child, launch = self.sink()

        def stale():
            sink.abort()
            return True

        self.assertFalse(sink.write(b"\0" * 4, stale))
        launch.assert_not_called()
        running = [True]

        def cancel(*args):
            running[0] = False
            sink.abort()
            return [], [], []

        with (
            patch("paj_voice_audio.devices.os.write", side_effect=BlockingIOError),
            patch("paj_voice_audio.devices.select.select", side_effect=cancel),
        ):
            self.assertFalse(sink.write(b"\0" * 4, lambda: running[0]))
        child.stop.assert_called_once()
        self.assertIsNone(sink.child)

    def test_backpressure_and_unexpected_exit_fail_closed(self):
        sink, child, _ = self.sink()
        with (
            patch("paj_voice_audio.devices.os.write", side_effect=BlockingIOError),
            patch("paj_voice_audio.devices.time.monotonic", side_effect=[0, 3]),
        ):
            with self.assertRaisesRegex(RuntimeError, "backpressure"):
                sink.write(b"\0" * 4, lambda: True)
        child.health.side_effect = RuntimeError("child exited")
        with self.assertRaisesRegex(RuntimeError, "child exited"):
            sink.health()

class CaptureTests(unittest.TestCase):
    def capture(self):
        errors = []
        turns = Mock()
        child = Mock()
        child.process.stdout.fileno.return_value = 123
        launch = Mock(return_value=child)
        capture = PipeCapture(
            PATHS["pw-record"], SOURCE, Vad, 0.01, turns, errors.append, launch=launch
        )
        self.addCleanup(capture.close)
        return capture, child, launch, turns, errors

    def test_pcm_readiness_with_synthetic_pipe_and_close_reaps(self):
        capture, child, launch, turns, errors = self.capture()
        read_fd, write_fd = os.pipe()
        source = os.fdopen(read_fd, "rb", buffering=0)
        child.process.stdout = source

        def stop():
            os.close(write_fd)

        child.stop.side_effect = stop
        capture.start()
        self.assertFalse(capture.first_pcm.is_set())
        os.write(write_fd, b"\0\0" * 512)
        capture.wait_ready(timeout=1)
        self.assertEqual(turns.feed.call_args.args, (b"\0\0" * 512, False))
        launch.assert_called_once_with(PATHS["pw-record"], SOURCE, 16000, True)
        capture.close()
        source.close()
        child.stop.assert_called_once()
        self.assertFalse(any(thread.is_alive() for thread in capture.threads))
        self.assertEqual(errors, [])

    def test_eof_truncated_pcm_and_overflow_fail_without_turn_submission(self):
        capture, child, _, turns, _ = self.capture()
        capture.child = child
        with patch("paj_voice_audio.devices.os.read", side_effect=[b"\1", b""]):
            capture._read()
        with self.assertRaisesRegex(RuntimeError, "EOF/discontinuity"):
            capture.wait_ready(timeout=0.01)
        turns.feed.assert_not_called()
        capture.fault = None
        capture.frames = queue.Queue(maxsize=1)
        with patch("paj_voice_audio.devices.os.read", return_value=b"\0" * 2048):
            capture._read()
        with self.assertRaisesRegex(RuntimeError, "overflow"):
            capture.health()
        turns.feed.assert_not_called()

    def test_stale_frames_timeout_and_child_loss_fail(self):
        capture, child, _, turns, errors = self.capture()
        capture.child = child
        capture.frames.put((time.monotonic() - 3, b"\0\0" * 512))
        capture._process()
        self.assertIn("stale", str(errors[0]))
        turns.feed.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "no PCM"):
            capture.wait_ready(timeout=0.01)
        child.health.side_effect = RuntimeError("lost capture")
        with self.assertRaisesRegex(RuntimeError, "lost capture"):
            capture.health()

    def test_close_clears_pending_audio(self):
        capture, child, _, _, _ = self.capture()
        capture.child = child
        capture._enqueue(b"\0\0" * 512)
        capture.close()
        self.assertTrue(capture.frames.empty())
        child.stop.assert_called_once()


if __name__ == "__main__":
    unittest.main()
