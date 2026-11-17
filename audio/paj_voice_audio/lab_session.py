import math
import re


QUESTION = "Was that message for me?"
MAX_TEXT = 4096
CAPTURE_SECONDS = 30.0
RECOGNITION_SECONDS = 10.0
PROMPT_SECONDS = 4.0
_AFFIRMATIVE = re.compile(r"(?:yes|of\s+course|that\s+was\s+for\s+you)[.!?,]*", re.I)


class AdmissionSession:
    def __init__(self, clock, confirmation_seconds=6):
        if not math.isfinite(confirmation_seconds) or confirmation_seconds <= 0:
            raise ValueError("Invalid confirmation duration")
        self._clock = clock
        self._confirmation_seconds = confirmation_seconds
        self._epoch = 0
        self._opened_at = clock()
        self._phase = "off"
        self._token = None
        self._blocked = None
        self._deadline = None
        self._held = None
        self._prompt_id = None
        self._prompt_serial = 0
        self._drained_at = None

    @property
    def epoch(self):
        return self._epoch

    @property
    def phase(self):
        return self._phase

    def arm(self):
        return self._clear("listening", "armed", resume=False)

    def off(self):
        return self._clear("off", "off", resume=False)

    def reset(self, reason="reset"):
        return self._clear(
            "off" if self._phase == "off" else "listening", "reset", resume=False
        )

    def _clear(self, phase, reason, admitted=None, resume=True):
        occupied = self._phase not in ("off", "listening")
        self._epoch += 1
        self._opened_at = self._clock()
        self._phase = phase
        self._token = None
        self._blocked = None
        self._deadline = None
        self._held = None
        self._prompt_id = None
        self._drained_at = None
        if admitted is not None:
            return [{"type": "admit", "text": admitted}]
        if occupied:
            effects = [{"type": "discard", "reason": reason}]
            if resume and phase != "off":
                effects.append({"type": "resume"})
            return effects
        return []

    def tick(self):
        if self._deadline is not None and self._clock() >= self._deadline:
            return self._clear("listening", "timeout")
        return []

    def onset(self, capture_epoch, captured_at=None):
        now = self._clock()
        captured_at = now if captured_at is None else captured_at
        if (
            not isinstance(captured_at, (int, float))
            or captured_at < self._opened_at
            or captured_at > now
            or not math.isfinite(captured_at)
            or captured_at + CAPTURE_SECONDS <= now
            or capture_epoch != self._epoch
            or self._token is not None
            or self._blocked is not None
            or (self._deadline is not None and now >= self._deadline)
        ):
            return None
        if self._phase == "prompt":
            self._blocked = object()
            return self._blocked
        if self._phase not in ("listening", "confirming"):
            return None
        if self._phase == "confirming" and captured_at <= self._drained_at:
            self._blocked = object()
            return self._blocked
        self._token = object()
        self._phase = "confirm_capturing" if self._held is not None else "capturing"
        self._deadline = captured_at + CAPTURE_SECONDS
        return self._token

    def end(self, token):
        effects = self.tick()
        if token is not None and token is self._blocked:
            self._blocked = None
            return effects
        if token is None or token is not self._token:
            return effects
        if self._phase not in ("capturing", "confirm_capturing"):
            return effects
        self._phase = "confirm_recognizing" if self._held is not None else "recognizing"
        self._deadline = self._clock() + RECOGNITION_SECONDS
        return effects

    def submit(self, token, text, decision):
        effects = self.tick()
        if token is None or token is not self._token:
            return effects
        if self._phase not in ("recognizing", "confirm_recognizing"):
            return effects
        if not isinstance(text, str) or len(text) > MAX_TEXT or not text.strip():
            return self._clear("listening", "invalid_text")
        if self._phase == "confirm_recognizing":
            if _AFFIRMATIVE.fullmatch(text.strip()):
                return self._clear("listening", "confirmed", admitted=self._held)
            return self._clear("listening", "not_confirmed")
        if decision == "accept":
            return self._clear("listening", "accepted", admitted=text)
        if decision != "uncertain":
            return self._clear("listening", "rejected")
        self._held = text
        self._token = None
        self._phase = "prompt"
        self._deadline = self._clock() + PROMPT_SECONDS
        self._prompt_serial += 1
        self._prompt_id = self._prompt_serial
        return [{"type": "prompt", "text": QUESTION, "id": self._prompt_id, "epoch": self._epoch}]

    def prompt_complete(self, prompt_id, epoch, ok):
        effects = self.tick()
        if (
            self._phase != "prompt"
            or epoch != self._epoch
            or prompt_id != self._prompt_id
        ):
            return effects
        if ok is not True:
            return self._clear("listening", "prompt_failed")
        self._prompt_id = None
        self._phase = "confirming"
        self._drained_at = self._clock()
        self._deadline = self._drained_at + self._confirmation_seconds
        return effects
