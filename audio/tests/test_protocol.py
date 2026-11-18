import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from paj_voice_audio.cli import AudioLock, Protocol, serve


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
