import array
import collections
import math
import queue
import threading
import time

from .devices import PipeCapture


class LabCapture(PipeCapture):
    def _process(self):
        try:
            while not self.closed.is_set():
                self.health()
                try:
                    captured, frame = self.frames.get(timeout=0.1)
                except queue.Empty:
                    continue
                if time.monotonic() - captured > 2:
                    raise RuntimeError("Stale capture; trial stopped")
                samples = array.array("h", frame)
                rms = math.sqrt(sum(value * value for value in samples) / len(samples)) / 32768
                voiced = self.vad(frame) >= 0.5 and rms >= self.threshold
                self.first_pcm.set()
                if not self.closed.is_set():
                    self.turns.feed(frame, voiced, captured_at=captured)
        except Exception as error:
            if not self.closed.is_set():
                self.fail(error)


class Segments:
    def __init__(self, emit, pause, epoch, clock=time.monotonic, silence=0.8, maximum=12):
        self.emit, self.pause, self.epoch, self.clock = emit, pause, epoch, clock
        self.silence, self.maximum = silence, maximum
        self.lock = threading.RLock()
        self.preroll = collections.deque()
        self.preroll_bytes = 0
        self.current = None
        self.serial = 0
        self.closed = False

    def clear_preroll(self):
        with self.lock:
            self.preroll.clear()
            self.preroll_bytes = 0

    def feed(self, pcm, voiced, captured_at=None):
        with self.lock:
            if self.closed:
                return
            if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2:
                raise ValueError("Invalid capture frame")
            received = self.clock()
            now = received if captured_at is None else captured_at
            if not math.isfinite(now) or now > received or received - now > 2:
                raise ValueError("Invalid capture timestamp")
            if self.current is None:
                self.preroll.append(pcm)
                self.preroll_bytes += len(pcm)
                while self.preroll_bytes > 32000:
                    self.preroll_bytes -= len(self.preroll.popleft())
                if not voiced:
                    return
                self.serial += 1
                self.current = {
                    "id": self.serial, "epoch": self.epoch(), "start": now,
                    "last": now, "pcm": bytearray(b"".join(self.preroll)),
                    "discard": False,
                }
                self.clear_preroll()
                self.pause()
                self.emit({"type": "onset", "id": self.serial,
                           "epoch": self.current["epoch"], "at": now})
            else:
                turn = self.current
                if not turn["discard"]:
                    turn["pcm"].extend(pcm)
                if voiced:
                    turn["last"] = now
                if not turn["discard"] and (now - turn["start"] > self.maximum
                                             or len(turn["pcm"]) > (self.maximum + 1) * 32000):
                    turn["pcm"].clear()
                    turn["discard"] = True
                    self.emit({"type": "truncated", "id": turn["id"]})
                if not voiced and now - turn["last"] >= self.silence:
                    self.current = None
                    self.emit({"type": "endpoint", "id": turn["id"],
                               "pcm": bytes(turn["pcm"]), "truncated": turn["discard"]})
                    turn["pcm"].clear()

    def close(self):
        with self.lock:
            self.closed = True
            if self.current:
                self.current["pcm"].clear()
            self.current = None
            self.clear_preroll()


class Speaker:
    def __init__(self, sink, emit, clock=time.monotonic):
        self.sink, self.emit, self.clock = sink, emit, clock
        self.cv = threading.Condition(threading.RLock())
        self.generation = 0
        self.active = None
        self.saved = None
        self.closed = False
        self.thread = threading.Thread(target=self._run, daemon=True, name="lab-playback")
        self.thread.start()

    def play(self, pcm, kind, ident=None, epoch=None):
        if not isinstance(pcm, bytes) or len(pcm) % 2 or len(pcm) > self.sink.rate * 120:
            raise ValueError("Invalid bounded playback")
        self.cancel()
        with self.cv:
            if self.closed:
                return
            self.active = {"pcm": pcm, "offset": 0, "kind": kind, "id": ident, "epoch": epoch}
            self.cv.notify_all()

    def pause(self):
        began = self.clock()
        with self.cv:
            if self.closed or not self.active or self.active["kind"] != "demo":
                return
            self.saved, self.active = self.active, None
            # Written audio can still be buffered downstream when the stream is aborted.
            self.saved["offset"] = max(0, self.saved["offset"] - self.sink.rate * 2)
            self.generation += 1
        self.sink.abort()
        self.emit({"type": "paused", "elapsedMs": (self.clock() - began) * 1000})

    def resume(self):
        with self.cv:
            if self.closed or self.active or not self.saved:
                return
            self.active, self.saved = self.saved, None
            self.cv.notify_all()

    def discard(self):
        with self.cv:
            self.saved = None

    def cancel(self):
        with self.cv:
            self.generation += 1
            self.active = None
        self.sink.abort()

    def _current(self, generation, item):
        with self.cv:
            return not self.closed and generation == self.generation and self.active is item

    def _run(self):
        try:
            while True:
                with self.cv:
                    self.cv.wait_for(lambda: self.closed or self.active is not None)
                    if self.closed:
                        return
                    item, generation = self.active, self.generation
                size = max(2, self.sink.rate // 25 * 2)
                while self._current(generation, item) and item["offset"] < len(item["pcm"]):
                    end = min(len(item["pcm"]), item["offset"] + size)
                    if not self.sink.write(item["pcm"][item["offset"]:end],
                                           lambda: self._current(generation, item)):
                        break
                    with self.cv:
                        if self._current(generation, item):
                            item["offset"] = end
                if self._current(generation, item):
                    self.sink.drain(lambda: self._current(generation, item))
                    with self.cv:
                        if self._current(generation, item):
                            self.active = None
                            self.emit({"type": "played", "kind": item["kind"],
                                       "id": item["id"], "epoch": item["epoch"]})
        except Exception as error:
            self.emit({"type": "fault", "reason": "playback_failed", "message": str(error)[:512]})

    def close(self):
        with self.cv:
            self.closed = True
            self.saved = self.active = None
            self.generation += 1
            self.cv.notify_all()
        try:
            self.sink.close()
        finally:
            self.thread.join(timeout=1)
