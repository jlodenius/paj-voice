import array
import collections
import math
import queue
import threading
import time

from .devices import CaptureFault, PipeCapture


class Capture(PipeCapture):
    def _process(self):
        try:
            while not self.closed.is_set():
                self.health()
                try:
                    captured, frame = self.frames.get(timeout=0.1)
                except queue.Empty:
                    continue
                if time.monotonic() - captured > 2:
                    raise CaptureFault('capture_stale_queue', "Stale capture; trial stopped")
                samples = array.array("h", frame)
                rms = math.sqrt(sum(value * value for value in samples) / len(samples)) / 32768
                voiced = self.vad(frame) >= 0.5 and rms >= self.threshold
                self.first_pcm.set()
                if not self.closed.is_set():
                    self.turns.feed(frame, voiced, captured_at=captured)
        except Exception as error:
            if not self.closed.is_set():
                self.fail(error if isinstance(error, CaptureFault)
                          else CaptureFault('capture_processing_failed', str(error)))


class Segments:
    def __init__(self, emit, pause, epoch, clock=time.monotonic, silence=0.8, maximum=120):
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
                    "speech_bytes": len(pcm), "discard": False,
                }
                self.clear_preroll()
                self.pause()
                if self.emit({"type": "onset", "id": self.serial,
                              "epoch": self.current["epoch"], "at": now}) is False:
                    self.discard()
            else:
                turn = self.current
                limit = int((self.maximum + 1) * 16000) * 2
                overflow = len(turn["pcm"]) + len(pcm) > limit
                if not turn["discard"]:
                    retained = pcm[:max(0, limit - len(turn["pcm"]))]
                    turn["pcm"].extend(retained)
                    if voiced:
                        turn["speech_bytes"] += len(retained)
                if voiced:
                    turn["last"] = now
                # Endpoint silence must not turn an otherwise complete utterance into a partial one.
                if not turn["discard"] and voiced and (now - turn["start"] > self.maximum or overflow):
                    turn["discard"] = True
                    self.emit({"type": "truncated", "id": turn["id"]})
                if not voiced and now - turn["last"] >= self.silence:
                    self.current = None
                    self.emit({"type": "endpoint", "id": turn["id"],
                               "pcm": bytes(turn["pcm"]), "truncated": turn["discard"],
                               "speech_seconds": turn["speech_bytes"] / 32000})
                    turn["pcm"].clear()

    def discard(self):
        with self.lock:
            if self.current:
                self.current['pcm'].clear()
            self.current = None
            self.clear_preroll()

    def close(self):
        with self.lock:
            self.closed = True
            self.discard()


class Speaker:
    def __init__(self, sink, emit):
        self.sink, self.emit = sink, emit
        self.activity = None
        self.cv = threading.Condition(threading.RLock())
        self.generation = 0
        self.active = None
        self.closed = False
        self.thread = threading.Thread(target=self._run, daemon=True, name="voice-playback")
        self.thread.start()

    def play(self, pcm, ident=None, *, rate=None):
        rate = self.sink.rate if rate is None else rate
        if not isinstance(pcm, bytes) or len(pcm) % 2 or len(pcm) > rate * 120:
            raise ValueError("Invalid bounded playback")
        with self.cv:
            if self.closed:
                return
            self.generation += 1
            self.active = {"pcm": pcm, "offset": 0, "id": ident, "rate": rate}
            self.cv.notify_all()

    def cancel(self):
        with self.cv:
            self.generation += 1
            self.active = None
            self.cv.notify_all()

    def _current(self, generation, item):
        with self.cv:
            return not self.closed and generation == self.generation and self.active is item

    def _run(self):
        try:
            handled_generation = 0
            while True:
                with self.cv:
                    self.cv.wait_for(lambda: self.closed or self.active is not None
                                     or self.generation != handled_generation)
                    if self.closed:
                        return
                    item, generation = self.active, self.generation
                self.sink.abort()
                handled_generation = generation
                if item is None:
                    continue
                if self.activity:
                    self.activity({"type": "playing", "id": item["id"], "generation": generation})
                size = max(2, item['rate'] // 25 * 2)
                while self._current(generation, item) and item["offset"] < len(item["pcm"]):
                    end = min(len(item["pcm"]), item["offset"] + size)
                    if not self.sink.write(item["pcm"][item["offset"]:end],
                                           lambda: self._current(generation, item), rate=item['rate']):
                        break
                    with self.cv:
                        if self._current(generation, item):
                            item["offset"] = end
                if self._current(generation, item):
                    self.sink.drain(lambda: self._current(generation, item))
                    with self.cv:
                        completed = self._current(generation, item)
                        if completed:
                            self.active = None
                    if completed:
                        self.emit({"type": "played", "id": item["id"]})
                self.sink.abort()
                if self.activity:
                    self.activity({"type": "idle", "id": item["id"], "generation": generation})
        except Exception as error:
            self.emit({"type": "fault", "reason": "playback_failed", "message": str(error)[:512]})

    def close(self):
        with self.cv:
            self.closed = True
            self.active = None
            self.generation += 1
            self.cv.notify_all()
        try:
            self.sink.close()
        finally:
            self.thread.join(timeout=1)
