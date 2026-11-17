import argparse
import fcntl
import json
import os
import queue
import select
import signal
import stat
import sys
import threading
import time
from pathlib import Path


class PipeOutput:
    def __init__(self, fd):
        self.fd = fd
        os.set_blocking(fd, False)

    def write(self, line):
        pending = memoryview(line.encode("utf-8"))
        deadline = time.monotonic() + 1
        while pending:
            if time.monotonic() > deadline:
                raise OSError("Parent stopped reading protocol output")
            if not select.select([], [self.fd], [], 0.1)[1]:
                continue
            try:
                written = os.write(self.fd, pending)
                pending = pending[written:]
            except BlockingIOError:
                pass

    def flush(self):
        pass

    def close(self):
        os.close(self.fd)


class AudioLock:
    def __init__(self):
        self.fd = None
        uid = os.getuid()
        runtime = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{uid}")
        root = Path(runtime)
        if not root.exists():
            root = Path(f"/tmp/paj-voice-{uid}")
            try:
                root.mkdir(mode=0o700)
            except FileExistsError:
                pass
        directory = os.open(
            root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        )
        try:
            info = os.fstat(directory)
            if info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
                raise RuntimeError(
                    "Audio lock directory must be user-owned and mode 0700"
                )
            self.fd = os.open(
                "paj-voice-audio.lock",
                os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=directory,
            )
            info = os.fstat(self.fd)
            if (
                info.st_uid != uid
                or not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise RuntimeError("Unsafe audio lock file")
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("Another paj-voice companion owns audio") from None
        except BaseException:
            self.close()
            raise
        finally:
            os.close(directory)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class Protocol:
    def __init__(self, output):
        self.output = output
        self.queue = queue.Queue(maxsize=128)
        self.failed = threading.Event()
        self.thread = threading.Thread(
            target=self._write, daemon=True, name="voice-protocol"
        )
        self.thread.start()

    def emit(self, frame):
        if self.failed.is_set():
            raise RuntimeError("Parent protocol output closed")
        line = json.dumps(frame, ensure_ascii=True, separators=(",", ":")) + "\n"
        if len(line) > 65536:
            raise RuntimeError("Parent protocol event exceeds line limit")
        try:
            self.queue.put_nowait(line)
        except queue.Full:
            raise RuntimeError("Parent protocol output queue full") from None

    def _write(self):
        try:
            while True:
                frame = self.queue.get()
                if frame is None:
                    return
                self.output.write(frame)
                self.output.flush()
        except (OSError, ValueError):
            self.failed.set()

    def close(self):
        try:
            self.queue.put(None, timeout=0.2)
        except queue.Full:
            pass
        self.thread.join(timeout=1)


def serve(source, emit, runtime_factory, transport_ok=lambda: True):
    runtime = runtime_factory(emit)
    inbox = queue.Queue(maxsize=8)
    stopped = threading.Event()

    def read_commands():
        try:
            while not stopped.is_set():
                line = source.readline(65537)
                while not stopped.is_set():
                    try:
                        inbox.put(line, timeout=0.1)
                        break
                    except queue.Full:
                        pass
                if not line:
                    return
        except Exception as error:
            while not stopped.is_set():
                try:
                    inbox.put(error, timeout=0.1)
                    return
                except queue.Full:
                    pass

    threading.Thread(target=read_commands, daemon=True, name="voice-input").start()
    try:
        while not runtime.closed:
            if not transport_ok():
                runtime.shutdown()
                return 1
            try:
                line = inbox.get(timeout=0.1)
            except queue.Empty:
                continue
            if isinstance(line, Exception):
                raise line
            if not line:
                break
            if len(line.encode("utf-8")) > 65536 or not line.endswith("\n"):
                raise ValueError("Invalid or oversized NDJSON line")

            def invalid_constant(value):
                raise ValueError("Nonfinite JSON number")

            frame = json.loads(line, parse_constant=invalid_constant)
            if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
                raise ValueError("Protocol commands must be objects with a type")
            runtime.command(frame)
    except Exception as error:
        runtime.fail(error)
    finally:
        stopped.set()
        runtime.shutdown()
    return 1 if runtime.failed else 0


def main():
    parser = argparse.ArgumentParser(
        description="Local paj-voice inherited-pipe audio companion"
    )
    parser.add_argument(
        "--devices",
        action="store_true",
        help="list native PipeWire source/sink names without opening audio or loading models",
    )
    parser.add_argument("--check", action="store_true", help="load bundled speech models and synthesize in RAM, without opening audio")
    args = parser.parse_args()
    if args.check:
        from .speech import SpeechInference

        root = os.environ.get("PAJ_VOICE_SPEECH_BUNDLE")
        if not root:
            parser.exit(1, "Build the project Nix package to select pinned speech models\n")
        models = SpeechInference(root)
        models.synthesize("Speech models are ready.")
        print("Bundled local speech models ready. No capture or playback opened.")
        return 0
    if args.devices:
        from .devices import Graph

        try:
            print(json.dumps(Graph().devices(), indent=2))
        except (OSError, ValueError, RuntimeError) as error:
            parser.exit(1, f"Cannot enumerate PipeWire devices: {error}\n")
        return 0
    output = PipeOutput(os.dup(sys.stdout.fileno()))
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    protocol = Protocol(output)
    lock = None
    try:
        lock = AudioLock()
        from .open_mic import Runtime

        def factory(emit):
            runtime = Runtime(emit)

            def terminate(signum, frame):
                runtime.shutdown()
                raise SystemExit(128 + signum)

            signal.signal(signal.SIGTERM, terminate)
            signal.signal(signal.SIGINT, terminate)
            return runtime

        return serve(
            sys.stdin, protocol.emit, factory, lambda: not protocol.failed.is_set()
        )
    except Exception as error:
        protocol.emit({"type": "error", "message": str(error)[:512]})
        return 1
    finally:
        if lock:
            lock.close()
        protocol.close()
        output.close()


if __name__ == "__main__":
    raise SystemExit(main())
