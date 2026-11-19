import array
import ctypes
import dataclasses
import fcntl
import json
import math
import os
import queue
import select
import shutil
import signal
import subprocess
import sys
import threading
import time


@dataclasses.dataclass(frozen=True)
class Node:
    name: str
    serial: str
    kind: str
    device: str | None = None
    bluetooth: bool = False


def command_paths():
    paths = {name: shutil.which(name) for name in ("pw-dump", "pw-record", "pw-play")}
    missing = [name for name, path in paths.items() if not path]
    if missing:
        raise RuntimeError(
            "Install PipeWire command-line tools; missing " + ", ".join(missing)
        )
    return paths


def node_properties(entry):
    return (entry.get("info") or {}).get("props") or {}


def exact_name(name, kind):
    if (
        not isinstance(name, str)
        or not name.strip()
        or name != name.strip()
        or len(name) > 1024
        or any(ord(char) < 32 or ord(char) == 127 for char in name)
        or name.lower() in ("default", "auto", "pipewire", "pulse", "0", "-1")
        or name.startswith("@DEFAULT")
        or (kind == "Audio/Source" and "monitor" in name.lower())
    ):
        raise ValueError(
            "Select an exact native PipeWire node.name, not a default or capture monitor"
        )


def select_node(entries, name, kind):
    exact_name(name, kind)
    matches = [
        entry
        for entry in entries
        if entry.get("type") == "PipeWire:Interface:Node"
        and node_properties(entry).get("node.name") == name
    ]
    if len(matches) != 1:
        raise RuntimeError(f"PipeWire node {name!r} must exist exactly once")
    entry = matches[0]
    props = node_properties(entry)
    if props.get("media.class") != kind:
        raise RuntimeError(f"PipeWire node {name!r} must have media.class {kind}")
    if entry.get("info", {}).get("state") == "error" or entry.get("info", {}).get(
        "error"
    ):
        raise RuntimeError(f"PipeWire node {name!r} is in an error state")
    if (
        kind == "Audio/Source"
        and str(props.get("stream.capture.sink", "false")).lower() == "true"
    ):
        raise ValueError("Capture monitors are not microphone sources")
    serial = str(props.get("object.serial", ""))
    if not serial.isascii() or not serial.isdecimal() or int(serial) <= 0:
        raise RuntimeError(f"PipeWire node {name!r} has no stable object.serial")
    device = physical_device(entries, props)
    return Node(name, serial, kind, device, bluetooth_device(entries, device))


def physical_device(entries, props):
    devices = [entry for entry in entries
               if entry.get('type') == 'PipeWire:Interface:Device'
               and str(entry.get('id')) == str(props.get('device.id'))]
    if len(devices) != 1:
        return None
    name = node_properties(devices[0]).get('device.name')
    if not isinstance(name, str) or not name.strip() or len(name) > 1024:
        return None
    return name


def bluetooth_device(entries, device):
    cards = [entry for entry in entries if entry.get('type') == 'PipeWire:Interface:Device'
             and node_properties(entry).get('device.name') == device]
    return len(cards) == 1 and node_properties(cards[0]).get('device.api') == 'bluez5'


def resolve_node(entries, name, kind, device=None):
    exact_name(name, kind)
    if device is None:
        return select_node(entries, name, kind)
    if not bluetooth_device(entries, device):
        selected = select_node(entries, name, kind)
        if selected.device != device:
            raise RuntimeError('Selected endpoint belongs to a different physical audio device')
        return selected
    matches = [entry for entry in entries
               if entry.get('type') == 'PipeWire:Interface:Node'
               and node_properties(entry).get('media.class') == kind
               and physical_device(entries, node_properties(entry)) == device]
    if len(matches) != 1:
        raise RuntimeError('Selected physical audio device is absent or ambiguous; Bluetooth requires microphone exposure and headset autoswitch policy')
    return select_node(entries, node_properties(matches[0]).get('node.name'), kind)


class Graph:
    def __init__(self, paths=None, run=None, clock=time.monotonic):
        self.clock = clock
        self.paths = paths if paths is not None else command_paths()
        self.run = run or subprocess.run
        self.bound = ()

    def snapshot(self, deadline=None):
        timeout = 3 if deadline is None else min(3, deadline - self.clock())
        if timeout <= 0:
            raise TimeoutError('Audio route transition deadline expired')
        try:
            result = self.run(
                [self.paths["pw-dump"], "--no-colors"],
                capture_output=True,
                check=True,
                timeout=timeout,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError(
                "Cannot inspect the current user PipeWire graph with pw-dump"
            ) from error
        if len(result.stdout) > 16 * 1024 * 1024:
            raise RuntimeError("PipeWire graph exceeds inspection limit")
        entries = json.loads(result.stdout)
        if not isinstance(entries, list):
            raise RuntimeError("pw-dump did not return a graph array")
        return entries

    def devices(self):
        result = []
        entries = self.snapshot()
        for entry in entries:
            props = node_properties(entry)
            name, kind = props.get("node.name"), props.get("media.class")
            if entry.get("type") != "PipeWire:Interface:Node" or kind not in (
                "Audio/Source",
                "Audio/Sink",
            ):
                continue
            try:
                node = select_node(entries, name, kind)
            except (ValueError, RuntimeError):
                continue
            result.append(
                {
                    "name": node.name,
                    "serial": node.serial,
                    **({"device": node.device} if node.device else {}),
                    **({"bluetooth": True} if node.bluetooth else {}),
                    "class": node.kind,
                    "description": props.get("node.description", ""),
                }
            )
        return result

    def bind(self, source, sink, input_device=None, output_device=None, deadline=None):
        entries = self.snapshot(deadline)
        self.bound = (
            resolve_node(entries, source, "Audio/Source", input_device),
            resolve_node(entries, sink, "Audio/Sink", output_device),
        )
        return self.bound

    def available(self, source, sink, input_device=None, output_device=None, deadline=None):
        entries = self.snapshot(deadline)
        result = []
        for name, kind, device in ((source, 'Audio/Source', input_device), (sink, 'Audio/Sink', output_device)):
            try:
                result.append(resolve_node(entries, name, kind, device))
            except (ValueError, RuntimeError):
                result.append(None)
        return tuple(result)

    def profile_transition(self, device, deadline=None):
        entries = self.snapshot(deadline)
        if not bluetooth_device(entries, device):
            return False
        cards = [entry for entry in entries if entry.get('type') == 'PipeWire:Interface:Device'
                 and node_properties(entry).get('device.name') == device]
        if len(cards) != 1:
            return False
        changed = False
        for expected in self.bound:
            if expected.device != device:
                continue
            matches = [entry for entry in entries if entry.get('type') == 'PipeWire:Interface:Node'
                       and node_properties(entry).get('media.class') == expected.kind
                       and physical_device(entries, node_properties(entry)) == device]
            if len(matches) > 1:
                return False
            if not matches:
                changed = True
                continue
            try:
                actual = select_node(entries, node_properties(matches[0]).get('node.name'), expected.kind)
            except (RuntimeError, ValueError):
                return False
            changed = changed or actual != expected
        return changed

    def recover(self, frozen, deadline=None):
        entries = self.snapshot(deadline)
        result = []
        for expected in frozen:
            try:
                if not expected.serial:
                    actual = resolve_node(entries, expected.name, expected.kind, expected.device)
                elif expected.bluetooth:
                    if not expected.device or not bluetooth_device(entries, expected.device):
                        raise RuntimeError('Bluetooth physical identity is unavailable')
                    actual = resolve_node(entries, expected.name, expected.kind, expected.device)
                else:
                    actual = select_node(entries, expected.name, expected.kind)
                    if actual.bluetooth or actual.device != expected.device:
                        raise RuntimeError('Physical audio device changed')
                    if expected.device is None and actual.serial != expected.serial:
                        raise RuntimeError('Cannot verify replacement audio device')
                result.append(actual)
            except (RuntimeError, ValueError):
                result.append(None)
        return tuple(result)

    def check(self, deadline=None):
        entries = self.snapshot(deadline)
        for expected in self.bound:
            actual = select_node(entries, expected.name, expected.kind)
            if actual != expected:
                raise RuntimeError(
                    f"PipeWire target {expected.name!r} was replaced; restart explicitly"
                )


def child_exec(parent, command):
    if not sys.platform.startswith("linux"):
        raise RuntimeError("Native audio child lifetime protection requires Linux")
    # Set this in a fresh interpreter, not a preexec_fn in the threaded audio worker.
    libc = ctypes.CDLL(None, use_errno=True)
    if os.getppid() != parent:
        return 1
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot protect PipeWire child lifetime")
    if os.getppid() != parent:
        return 1
    os.execv(command[0], command)
    return 1


class ChildStartError(RuntimeError):
    def __init__(self, child, confirmed):
        super().__init__('Audio child startup failed; process was stopped' if confirmed
                         else 'Audio child startup failed; process closure unconfirmed')
        self.child = child


class Child:
    def __init__(self, executable, node, rate, capture):
        properties = json.dumps(
            {
                "node.dont-fallback": True,
                "node.dont-reconnect": True,
                "node.name": "paj_voice_record" if capture else "paj_voice_play",
                "application.id": "org.paj.voice",
                "paj.voice.owner": str(os.getpid()),
            }
        )
        args = [
            executable,
            "--raw",
            "--target",
            node.serial,
            "--rate",
            str(rate),
            "--channels",
            "1",
            "--format",
            "s16",
            "--latency",
            "50ms",
            "--properties",
            properties,
            "-",
        ]
        self.closed = False
        self.stop_complete = False
        self.fault = None
        self.lock = threading.RLock()
        self.stderr_thread = None
        self.stderr_started = False
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-P",
                "-m",
                "paj_voice_audio.devices",
                "--child",
                str(os.getpid()),
                *args,
            ],
            stdin=subprocess.DEVNULL if capture else subprocess.PIPE,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            bufsize=0,
            start_new_session=True,
        )
        try:
            self.stderr_thread = threading.Thread(
                target=self._stderr, daemon=True, name="pipewire-errors"
            )
            self.stderr_thread.start()
            self.stderr_started = True
            if not capture:
                fd = self.process.stdin.fileno()
                os.set_blocking(fd, False)
                try:
                    fcntl.fcntl(fd, fcntl.F_SETPIPE_SZ, 8192)
                except OSError:
                    if fcntl.fcntl(fd, fcntl.F_GETPIPE_SZ) > 65536:
                        raise RuntimeError("PipeWire playback pipe exceeds buffer limit")
        except Exception as error:
            try:
                self.stop()
            except Exception:
                raise ChildStartError(self, False) from error
            raise ChildStartError(self, True) from error

    def _stderr(self):
        pending = b""
        try:
            while not self.closed:
                data = self.process.stderr.read(4096)
                if not data:
                    return
                pending = (pending + data)[-4096:]
                if any(
                    marker in pending.lower()
                    for marker in (b"xrun", b"overrun", b"underrun", b"discontinu")
                ):
                    self.fault = (
                        "PipeWire reported audio discontinuity; request discarded"
                    )
        except (OSError, ValueError):
            if not self.closed:
                self.fault = "PipeWire diagnostic pipe failed"

    def health(self, allow_exit=False):
        if self.fault:
            raise RuntimeError(self.fault)
        code = self.process.poll()
        if not self.closed and code is not None and not (allow_exit and code == 0):
            raise RuntimeError("PipeWire audio process exited unexpectedly")

    def stop(self):
        with self.lock:
            if self.stop_complete:
                return
            self.closed = True
            if self.process.poll() is None:
                try:
                    self.process.terminate()
                    self.process.wait(timeout=0.3)
                except (OSError, subprocess.TimeoutExpired):
                    if self.process.poll() is None:
                        self.process.kill()
                    self.process.wait(timeout=1)
            else:
                self.process.wait(timeout=1)
            if self.process.poll() is None:
                raise RuntimeError('Recorder/process exit is unconfirmed')
            for stream in (
                self.process.stdin,
                self.process.stdout,
                self.process.stderr,
            ):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
            self.stop_complete = True
        if self.stderr_started and threading.current_thread() is not self.stderr_thread:
            self.stderr_thread.join(timeout=0.2)


class PipeSink:
    # A bounded silent lead-in gives newly opened output routes time to become audible.
    LEAD_IN_MS = 300

    def __init__(self, executable, node, rate, launch=Child):
        self.executable, self.node, self.rate = executable, node, rate
        self.launch = launch
        self.lock = threading.RLock()
        self.serial = 0
        self.child = None
        self.retired_children = []
        self.closed = False
        self.draining = False

    def write(self, pcm, current):
        if len(pcm) % 2 or len(pcm) > self.rate * 2 * 60:
            raise RuntimeError("Synthesized audio exceeds safety limit")
        with self.lock:
            serial = self.serial
        pending = memoryview(pcm)
        lead_in = 0
        last_progress = time.monotonic()
        while (pending or lead_in) and current():
            try:
                with self.lock:
                    if self.closed or serial != self.serial:
                        return False
                    if self.child is None:
                        try:
                            self.child = self.launch(
                                self.executable, self.node, self.rate, False
                            )
                        except ChildStartError as error:
                            self.child = error.child
                            raise
                        lead_in = self.rate * self.LEAD_IN_MS // 1000 * 2
                    child = self.child
                    child.health()
                    fd = child.process.stdin.fileno()
                    try:
                        data = bytes(min(lead_in, 4096)) if lead_in else pending[:4096]
                        count = os.write(fd, data)
                    except BlockingIOError:
                        count = 0
                    if lead_in:
                        lead_in -= count
                    else:
                        pending = pending[count:]
                if count:
                    last_progress = time.monotonic()
                elif time.monotonic() - last_progress > 2:
                    raise RuntimeError(
                        "PipeWire playback backpressure exceeded safety limit"
                    )
                else:
                    select.select([], [fd], [], 0.02)
            except (OSError, ValueError):
                if not current():
                    return False
                with self.lock:
                    if serial != self.serial:
                        return False
                raise
        valid = current()
        with self.lock:
            return valid and not self.closed and serial == self.serial

    def drain(self, current):
        with self.lock:
            child = self.child
            if child is None:
                return
            self.draining = True
            child.process.stdin.close()
        deadline = time.monotonic() + 5
        while current() and child.process.poll() is None:
            child.health(allow_exit=True)
            if time.monotonic() > deadline:
                raise RuntimeError("PipeWire playback did not drain in time")
            time.sleep(0.02)
        if not current():
            return
        child.health(allow_exit=True)
        with self.lock:
            if self.child is child:
                self.child = None
                self.draining = False
        child.stop()

    def abort(self):
        with self.lock:
            self.serial += 1
            child, self.child = self.child, None
            self.draining = False
            if child is not None:
                self.retired_children.append(child)
            retired = list(self.retired_children)
        failure = None
        for child in retired:
            try:
                child.stop()
            except Exception as error:
                failure = error
            else:
                with self.lock:
                    if child in self.retired_children:
                        self.retired_children.remove(child)
        if failure is not None:
            raise failure

    def health(self):
        with self.lock:
            if self.child:
                self.child.health(allow_exit=self.draining)

    def close(self):
        with self.lock:
            self.closed = True
        self.abort()


class PipeCapture:
    def __init__(
        self, executable, node, vad_factory, threshold, turns, fail, launch=Child
    ):
        self.executable, self.node = executable, node
        self.vad = vad_factory()
        self.threshold, self.turns, self.fail = threshold, turns, fail
        self.launch = launch
        self.frames = queue.Queue(maxsize=64)
        self.closed = threading.Event()
        self.close_complete = False
        self.close_lock = threading.Lock()
        self.first_pcm = threading.Event()
        self.fault = None
        self.child = None
        self.threads = []
        self.last_pcm = time.monotonic()

    def start(self):
        try:
            self.child = self.launch(self.executable, self.node, 16000, True)
        except ChildStartError as error:
            self.child = error.child
            raise
        self.last_pcm = time.monotonic()
        for target, name in ((self._read, 'pipewire-capture'), (self._process, 'voice-vad')):
            thread = threading.Thread(target=target, daemon=True, name=name)
            thread.start()
            self.threads.append(thread)

    def _enqueue(self, frame):
        try:
            self.frames.put_nowait((time.monotonic(), frame))
        except queue.Full:
            raise RuntimeError("Capture queue overflow; request discarded") from None

    def _read(self):
        pending = bytearray()
        size = self.vad.chunk_bytes()
        try:
            while not self.closed.is_set():
                data = os.read(self.child.process.stdout.fileno(), 4096)
                if not data:
                    if not self.closed.is_set():
                        raise RuntimeError(
                            "PipeWire capture EOF/discontinuity; request discarded"
                        )
                    return
                pending.extend(data)
                while len(pending) >= size:
                    frame = bytes(pending[:size])
                    del pending[:size]
                    self.last_pcm = time.monotonic()
                    self._enqueue(frame)
        except (OSError, ValueError, RuntimeError) as error:
            if not self.closed.is_set():
                self.fault = str(error)
        finally:
            pending.clear()

    def _process(self):
        try:
            while not self.closed.is_set():
                self.health()
                try:
                    captured, frame = self.frames.get(timeout=0.1)
                except queue.Empty:
                    continue
                if time.monotonic() - captured > 2:
                    raise RuntimeError("Capture queue is stale; request discarded")
                samples = array.array("h", frame)
                rms = (
                    math.sqrt(sum(sample * sample for sample in samples) / len(samples))
                    / 32768
                )
                voiced = self.vad(frame) >= 0.5 and rms >= self.threshold
                self.health()
                self.first_pcm.set()
                if not self.closed.is_set():
                    self.turns.feed(frame, voiced)
                del frame, samples
        except Exception as error:
            if not self.closed.is_set():
                self.fail(error)

    def wait_ready(self, timeout=3):
        deadline = time.monotonic() + timeout
        while not self.first_pcm.wait(0.05):
            if self.closed.is_set():
                raise RuntimeError("Capture was cancelled before receiving PCM")
            self.health()
            if time.monotonic() > deadline:
                raise RuntimeError(
                    "PipeWire capture produced no PCM; check the selected microphone and PipeWire routing"
                )
        self.health()

    def health(self):
        if self.closed.is_set():
            return
        if self.fault or time.monotonic() - self.last_pcm > 2:
            raise RuntimeError(
                self.fault or "PipeWire capture stalled; request discarded"
            )
        if self.child:
            self.child.health()

    def close(self):
        with self.close_lock:
            if self.close_complete:
                return
            self.closed.set()
            if self.child:
                self.child.stop()
                if self.child.process.poll() is None:
                    raise RuntimeError('Recorder exit is unconfirmed')
            for thread in self.threads:
                if thread is not threading.current_thread():
                    thread.join(timeout=0.3)
            while True:
                try:
                    self.frames.get_nowait()
                except queue.Empty:
                    break
            self.close_complete = True


if __name__ == "__main__":
    if len(sys.argv) < 5 or sys.argv[1] != "--child":
        raise SystemExit("This module is an internal PipeWire child launcher")
    raise SystemExit(child_exec(int(sys.argv[2]), sys.argv[3:]))
