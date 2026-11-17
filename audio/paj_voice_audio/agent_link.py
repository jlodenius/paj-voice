import json
from pathlib import Path
import socket
import threading


class AgentLink:
    def __init__(self, path, session):
        if not Path(path).is_absolute() or not session:
            raise ValueError("An absolute local socket and exact Pi session are required")
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(2)
        self.lock = threading.Lock()
        self.closed = threading.Event()
        self.thread = None
        self.buffer = b""
        self.sequence = 0
        self.acknowledged = 0
        try:
            self.socket.connect(path)
            self.send({"type": "hello", "version": 1, "sessionId": session})
            response = self.read()
            if response != {"type": "hello", "version": 1, "sessionId": session}:
                raise RuntimeError("Voice target did not confirm the exact session")
            self.socket.settimeout(0.5)
        except BaseException:
            self.socket.close()
            raise

    def send(self, frame):
        data = (json.dumps(frame) + "\n").encode()
        if len(data) > 8192:
            raise ValueError("Agent frame exceeds the bounded protocol")
        with self.lock:
            if self.closed.is_set():
                raise RuntimeError("Agent connection is closed; no automatic retry")
            try:
                self.socket.sendall(data)
            except OSError:
                try:
                    self.socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                raise RuntimeError("Agent delivery is uncertain; no automatic retry") from None

    def read(self):
        while b"\n" not in self.buffer:
            data = self.socket.recv(4096)
            if not data:
                raise RuntimeError("Agent disconnected")
            self.buffer += data
            if len(self.buffer.split(b"\n", 1)[0]) > 8192:
                raise RuntimeError("Agent frame exceeds the bounded protocol")
        line, self.buffer = self.buffer.split(b"\n", 1)
        if len(line) > 8192:
            raise RuntimeError("Agent frame exceeds the bounded protocol")
        frame = json.loads(line)
        if not isinstance(frame, dict):
            raise RuntimeError("Invalid agent frame")
        return frame

    def start(self, receive, fault):
        def run():
            try:
                while not self.closed.is_set():
                    try:
                        frame = self.read()
                    except socket.timeout:
                        continue
                    if frame.get("type") == "answer":
                        text, generation = frame.get("text"), frame.get("generation")
                        if (not isinstance(text, str) or not text.strip() or len(text) > 320
                                or len(text.split()) > 50 or any(ord(ch) < 32 for ch in text)
                                or type(generation) is not int or not 1 <= generation <= 1000):
                            raise RuntimeError("Invalid spoken answer")
                        receive({"type": "agent_answer", "generation": generation, "text": text})
                    elif (frame.get("type") == "accepted" and type(frame.get("sequence")) is int
                          and frame["sequence"] == self.acknowledged + 1
                          and frame["sequence"] <= self.sequence):
                        self.acknowledged = frame["sequence"]
                        receive({"type": "agent_accepted", "sequence": frame["sequence"]})
                    elif frame.get("type") == "reply_status":
                        if (not isinstance(frame.get("stage"), str) or len(frame["stage"]) > 32
                                or not isinstance(frame.get("reason"), str) or len(frame["reason"]) > 64
                                or (frame.get("generation") is not None
                                    and (type(frame["generation"]) is not int or not 1 <= frame["generation"] <= 1000))):
                            raise RuntimeError("Invalid reply status")
                        receive({"type": "agent_status", "stage": frame["stage"],
                                 "reason": frame["reason"], "generation": frame.get("generation")})
                    elif frame.get("type") != "armed":
                        raise RuntimeError("Unexpected agent frame")
            except Exception:
                if not self.closed.is_set():
                    fault()
        self.thread = threading.Thread(target=run, daemon=True, name="voice-agent-link")
        self.thread.start()

    def arm(self, seconds):
        self.send({"type": "arm", "seconds": seconds})

    def onset(self, generation):
        self.send({"type": "onset", "generation": generation})

    def submit(self, generation, text):
        self.sequence += 1
        self.send({"type": "utterance", "sequence": self.sequence,
                   "generation": generation, "text": text})

    def close(self):
        self.closed.set()
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.socket.close()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=1)
