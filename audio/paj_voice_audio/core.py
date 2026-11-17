import collections
import dataclasses
import re
import threading
import time
import unicodedata
import uuid

_WORD = re.compile(r"\w+(?:'\w+)?")
_ID = re.compile(r"[\w-]{1,128}", re.ASCII)


def prefix(text, phrases):
    words = list(_WORD.finditer(text.lower()))
    for phrase in sorted(phrases, key=len, reverse=True):
        wanted = phrase.split()
        if [word.group() for word in words[: len(wanted)]] == wanted:
            content = text[words[len(wanted) - 1].end() :]
            while content and (
                content[0].isspace() or unicodedata.category(content[0]).startswith("P")
            ):
                content = content[1:]
            return phrase, content
    return None, ""


class Playback:
    def __init__(self, synthesize, sink, emit, fail, limit=8, start_worker=True):
        self.synthesize = synthesize
        self.sink = sink
        self.emit = emit
        self.fail = fail
        self.limit = limit
        self.cv = threading.Condition(threading.RLock())
        self.queue = collections.deque()
        self.epoch = 0
        self.closed = False
        self.active = None
        self.synthesis_since = None
        self.seen = collections.OrderedDict()
        self.thread = threading.Thread(target=self._run, daemon=True, name="voice-tts")
        if start_worker:
            self.thread.start()

    def enqueue(self, frame):
        ident, text = frame.get("id"), frame.get("text")
        key = frame.get("key")
        if (
            not isinstance(ident, str)
            or not _ID.fullmatch(ident)
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > 320
            or len(text.split()) > 50
            or any(ord(c) < 32 or ord(c) == 127 for c in text)
            or frame.get("priority", "normal") not in ("normal", "urgent")
            or (
                key is not None
                and (not isinstance(key, str) or not key or len(key) > 128)
            )
        ):
            raise ValueError("Invalid bounded speech request")
        with self.cv:
            if self.closed:
                return False
            signature = (text, key, frame.get("priority", "normal"))
            if ident in self.seen:
                if self.seen[ident] != signature:
                    raise ValueError("Conflicting speech ID")
                return False
            if frame.get("priority") == "urgent":
                self.stop()
            if key is not None:
                self.queue = collections.deque(
                    item for item in self.queue if item.get("key") != key
                )
            if len(self.queue) >= self.limit:
                raise RuntimeError("Speech queue limit exceeded")
            self.seen[ident] = signature
            while len(self.seen) > 512:
                self.seen.popitem(last=False)
            self.queue.append(dict(frame))
            self.cv.notify_all()
            return True

    def stop(self):
        with self.cv:
            self.epoch += 1
            self.queue.clear()
            self.sink.abort()
            if self.active is not None:
                self.emit({"type": "speech_end", "id": self.active})
                self.active = None
            self.cv.notify_all()

    def close(self):
        with self.cv:
            self.closed = True
            self.stop()

    def health(self):
        with self.cv:
            if (
                self.synthesis_since is not None
                and time.monotonic() - self.synthesis_since > 15
            ):
                raise RuntimeError("Local synthesis exceeded latency safety limit")

    def _run(self):
        try:
            while True:
                with self.cv:
                    self.cv.wait_for(lambda: self.closed or self.queue)
                    if self.closed:
                        return
                    frame = self.queue.popleft()
                    epoch = self.epoch
                iterator = iter(self.synthesize(frame["text"]))
                try:
                    while self._current(epoch):
                        with self.cv:
                            self.synthesis_since = time.monotonic()
                        try:
                            chunk = next(iterator)
                        except StopIteration:
                            break
                        finally:
                            with self.cv:
                                self.synthesis_since = None
                        with self.cv:
                            if self.closed or epoch != self.epoch:
                                break
                            if self.active is None and chunk:
                                self.active = frame["id"]
                                self.emit({"type": "speech_start", "id": self.active})
                        if not self.sink.write(
                            chunk, lambda epoch=epoch: self._current(epoch)
                        ):
                            break
                finally:
                    close = getattr(iterator, "close", None)
                    if close:
                        close()
                if self._current(epoch):
                    self.sink.drain(lambda epoch=epoch: self._current(epoch))
                    with self.cv:
                        if epoch == self.epoch and self.active is not None:
                            self.emit({"type": "speech_end", "id": self.active})
                            self.active = None
        except Exception as error:
            self.fail(error)

    def _current(self, epoch):
        with self.cv:
            return not self.closed and epoch == self.epoch


@dataclasses.dataclass
class Turn:
    id: str
    epoch: int
    pcm: bytearray = dataclasses.field(default_factory=bytearray)
    silence: int = 0
    next_prefix: int = 16000
    hypothesis: str | None = None
    confirmations: int = 0
    addressed: bool = False
    ended: bool = False
    ended_at: float = 0


class Turns:
    def __init__(
        self,
        settings,
        phrases,
        transcribe,
        playback,
        emit,
        fail,
        clock=time.monotonic,
        start_worker=True,
    ):
        self.settings = settings
        self.phrases = phrases
        self.transcribe = transcribe
        self.playback = playback
        self.emit = emit
        self.fail = fail
        self.clock = clock
        self.cv = threading.Condition(threading.RLock())
        self.epoch = 0
        self.muted = False
        self.closed = False
        self.turns = {}
        self.current = None
        self.preroll = collections.deque()
        self.preroll_bytes = 0
        self.partial = None
        self.finals = collections.deque()
        self.busy_since = None
        self.thread = threading.Thread(target=self._run, daemon=True, name="voice-asr")
        if start_worker:
            self.thread.start()

    def feed(self, pcm, voiced):
        with self.cv:
            if self.closed or self.muted:
                return
            if len(pcm) % 2:
                raise ValueError("Unaligned PCM")
            if not self.current:
                if not voiced:
                    self.preroll.append(pcm)
                    self.preroll_bytes += len(pcm)
                    while self.preroll_bytes > 32000 and self.preroll:
                        self.preroll_bytes -= len(self.preroll.popleft())
                    return
                if len(self.turns) >= 3:
                    raise RuntimeError("Recognition fell behind live speech")
                turn = Turn(uuid.uuid4().hex, self.epoch)
                turn.pcm.extend(b"".join(self.preroll))
                self.preroll.clear()
                self.preroll_bytes = 0
                self.turns[turn.id] = turn
                self.current = turn
            turn = self.current
            turn.pcm.extend(pcm)
            samples = len(turn.pcm) // 2
            if samples > self.settings["maxSeconds"] * 16000:
                raise RuntimeError(
                    "Maximum turn length exceeded; no truncated request was submitted"
                )
            turn.silence = 0 if voiced else turn.silence + len(pcm) // 2
            if turn.silence >= self.settings["silenceMs"] * 16:
                turn.ended = True
                turn.ended_at = self.clock()
                self.finals.append(turn)
                self.partial = None
                self.current = None
                self.cv.notify_all()
            elif not turn.addressed and samples >= turn.next_prefix:
                turn.next_prefix = samples + int(self.settings["prefixIntervalMs"] * 16)
                self.partial = (turn, bytes(turn.pcm[: 16000 * 2 * 4]))
                self.cv.notify_all()

    def reset(self, muted=False):
        with self.cv:
            self.epoch += 1
            self.muted = muted
            for turn in self.turns.values():
                turn.pcm.clear()
            self.turns.clear()
            self.current = None
            self.preroll.clear()
            self.preroll_bytes = 0
            self.partial = None
            self.finals.clear()
            self.cv.notify_all()

    def close(self):
        with self.cv:
            self.closed = True
            self.reset(True)

    def health(self):
        with self.cv:
            if self.busy_since is not None and self.clock() - self.busy_since > 10:
                raise RuntimeError("Local recognition exceeded latency safety limit")

    def _valid(self, turn):
        return (
            not self.closed
            and not self.muted
            and turn.epoch == self.epoch
            and self.turns.get(turn.id) is turn
        )

    def _address(self, turn):
        if not turn.addressed:
            self.playback.stop()
            turn.addressed = True
            if self.partial is not None and self.partial[0] is turn:
                self.partial = None
            self.emit({"type": "addressed", "id": turn.id})

    def result(self, turn, text, final):
        with self.cv:
            if not self._valid(turn):
                return
            phrase, content = prefix(text, self.phrases)
            if final:
                if self.clock() - turn.ended_at > 8:
                    raise RuntimeError(
                        "Final recognition became stale; request discarded"
                    )
                if phrase:
                    self._address(turn)
                    if content.strip():
                        if len(content) > 16384:
                            raise RuntimeError("Recognition text limit exceeded")
                        self.emit(
                            {
                                "type": "utterance",
                                "id": turn.id,
                                "text": content.strip(),
                            }
                        )
                    else:
                        self.emit({"type": "cancelled", "id": turn.id})
                elif turn.addressed:
                    self.emit({"type": "cancelled", "id": turn.id})
                turn.pcm.clear()
                self.turns.pop(turn.id, None)
            elif not turn.ended and not turn.addressed:
                turn.confirmations = (
                    turn.confirmations + 1
                    if phrase and phrase == turn.hypothesis
                    else int(bool(phrase))
                )
                turn.hypothesis = phrase
                if turn.confirmations >= 2:
                    self._address(turn)

    def _run(self):
        try:
            while True:
                with self.cv:
                    self.cv.wait_for(lambda: self.closed or self.finals or self.partial)
                    if self.closed:
                        return
                    if self.finals:
                        turn = self.finals.popleft()
                        pcm, final = bytes(turn.pcm), True
                        if self.clock() - turn.ended_at > 3:
                            raise RuntimeError("Recognition input queue became stale")
                    else:
                        turn, pcm = self.partial
                        self.partial = None
                        final = False
                    if not self._valid(turn):
                        continue
                    self.busy_since = self.clock()
                text = self.transcribe(pcm)
                with self.cv:
                    self.busy_since = None
                self.result(turn, text, final)
                del pcm, turn, text
        except Exception as error:
            self.fail(error)
