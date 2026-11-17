"""Bounded continuous speech: local demo or explicit read-only Pi bridge."""

import argparse
import json
import os
import queue
import re
import sys
import threading
import time

from .input_ready import InputReady
from .lab import Inference, close_owned, model_bundle
from .lab_audio import LabCapture, Segments, Speaker


ANNOUNCEMENT = "This is a test. Listening begins after the beep. Nothing you say will execute a command."
RESPONSE = ("Request heard. This is a test; nothing was executed. "
            "You can interrupt this response with another request.")


def echo_candidate(text):
    tokens = re.findall(r"[a-z]+", text.lower())
    if len(tokens) < 2:
        return False
    for phrase in (ANNOUNCEMENT, RESPONSE):
        reference = re.findall(r"[a-z]+", phrase.lower())
        if any(tokens == reference[start:start + len(tokens)] for start in range(len(reference))):
            return True
    return False


class Exchange:
    def __init__(self):
        self.lock = threading.RLock()
        self.generation = 0
        self.active = False
        self.closed = False

    def onset(self):
        with self.lock:
            if self.closed:
                return None
            self.generation += 1
            self.active = True
            return self.generation

    def endpoint(self, generation):
        with self.lock:
            if generation == self.generation:
                self.active = False

    def can_reply(self, generation, text):
        with self.lock:
            return (not self.closed and generation == self.generation and not self.active
                    and bool(text.strip()) and not echo_candidate(text))

    def close(self):
        with self.lock:
            self.closed = True
            self.active = False
            self.generation += 1


def trial(args, inference, agent=None):
    from pysilero_vad import SileroVoiceActivityDetector
    from .cli import AudioLock
    from .devices import Graph, PipeSink

    graph = Graph()
    source, target = graph.bind(args.input, args.output)
    if source.name.startswith("bluez"):
        raise ValueError("Use the laptop microphone, not a Bluetooth microphone")
    warmup_only = getattr(args, "warmup_only", False)
    announcement = inference.synthesize(
        "Microphone readiness check. Remain quiet until this test ends." if warmup_only else
        "This is a read only agent trial. Listening begins after the beep. All model tools are blocked."
        if agent else ANNOUNCEMENT)
    response = None if agent or warmup_only else inference.synthesize(RESPONSE)
    np = inference.np
    length = int(inference.rate * 0.1)
    tone = (np.sin(2 * np.pi * 800 * np.arange(length) / inference.rate)
            * np.hanning(length) * 1200).astype("<i2").tobytes()
    stopped, failed = threading.Event(), threading.Event()
    events, jobs = queue.Queue(maxsize=64), queue.Queue(maxsize=2)
    speech_jobs = queue.Queue(maxsize=2) if agent else None
    inference_lock = threading.Lock()
    spoken = []
    exchange = Exchange()
    capture = gate = segments = speaker = sink = audio_lock = timer = None
    tokens = {}
    busy = [None]
    synthesis_busy = [None]
    completed = 0

    def owned_echo(text):
        if echo_candidate(text):
            return True
        tokens = re.findall(r"[a-z]+", text.lower())
        if len(tokens) < 2:
            return False
        with exchange.lock:
            return any(any(tokens == reference[start:start + len(tokens)]
                           for start in range(len(reference))) for reference in spoken)

    def fail(error=None):
        failed.set()
        stopped.set()

    def emit(frame):
        if stopped.is_set():
            return
        if frame["type"] == "onset":
            frame["generation"] = exchange.generation
        try:
            events.put_nowait(frame)
        except queue.Full:
            fail()

    def interrupt():
        started = time.monotonic()
        exchange.onset()
        with speaker.cv:
            was_playing = speaker.active is not None
        speaker.pause()
        speaker.discard()
        emit({"type": "interrupt", "generation": exchange.generation,
              "processMs": (time.monotonic() - started) * 1000,
              "playbackWasActive": was_playing})
        if agent:
            agent.onset(exchange.generation)

    def expire():
        stopped.set()
        exchange.close()
        if close_owned((("gate", gate), ("capture", capture), ("speaker", speaker))):
            failed.set()

    def readiness_error(message):
        report = gate.snapshot()
        report["elapsedSeconds"] = round(time.monotonic() - (deadline - 5), 3)
        print(json.dumps({"warmupFailure": report}), flush=True)
        return RuntimeError(message)

    def agent_fault():
        failed.set()
        expire()

    def synthesize():
        while not stopped.is_set():
            try:
                job = speech_jobs.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                if not exchange.can_reply(job["generation"], job["text"]):
                    emit({"type": "agent_status", "stage": "synthesis", "reason": "stale_before_render",
                          "generation": job["generation"]})
                    continue
                synthesis_busy[0] = time.monotonic()
                with inference_lock:
                    pcm = inference.synthesize(job["text"])
                emit({"type": "agent_audio", **job, "pcm": pcm,
                      "renderMs": round((time.monotonic() - synthesis_busy[0]) * 1000, 1)})
            except Exception:
                fail()
            finally:
                synthesis_busy[0] = None
                job.clear()

    def recognize():
        while not stopped.is_set():
            try:
                job = jobs.get(timeout=0.1)
            except queue.Empty:
                continue
            text = None
            try:
                busy[0] = time.monotonic()
                with inference_lock:
                    text, milliseconds = inference.transcribe(job.pop("pcm"))
                if not stopped.is_set():
                    emit({"type": "recognized", **job, "text": text, "asrMs": milliseconds})
            except Exception:
                fail()
            finally:
                text = None
                busy[0] = None
                job.clear()

    try:
        audio_lock = AudioLock()
        sink = PipeSink(graph.paths["pw-play"], target, inference.rate)
        if agent:
            print("REAL AGENT TRIAL: all recognized requests go to the selected Pi model provider.", flush=True)
            print("Pi normally saves these messages in session history. No audio is uploaded or saved.", flush=True)
            print("All model tools are blocked. Playback interruption does not cancel model processing.", flush=True)
            agent.start(emit, agent_fault)
        else:
            print("CONTINUOUS TEST: all speech is for this test. No classifier or real agent connection.", flush=True)
        print("Headphones required. Ctrl-C stops capture. No audio files are saved.", flush=True)
        print("Voice-controlled mute is not implemented in this test; use Ctrl-C or the timeout.", flush=True)
        if warmup_only:
            print("READINESS ONLY: no transcription, replay, agent connection, or provider requests.", flush=True)
        print("Transcripts are " + ("visible in terminal scrollback." if args.show_text else "hidden; use --show-text to inspect them."), flush=True)
        input("Press Enter to consent to one bounded continuous microphone session: ")
        if stopped.is_set():
            raise RuntimeError("Agent disconnected before recording started")
        if agent:
            agent.arm(args.seconds)
        for start in range(0, len(announcement), 4096):
            sink.write(announcement[start:start + 4096], lambda: not stopped.is_set())
        sink.drain(lambda: not stopped.is_set())
        speaker = Speaker(sink, emit)
        segments = Segments(emit, interrupt, lambda: exchange.generation)
        gate = InputReady(segments)
        capture = LabCapture(graph.paths["pw-record"], source, SileroVoiceActivityDetector,
                             0.001, gate, fail)
        graph.check()
        deadline = time.monotonic() + 5
        maximum = 6 if warmup_only else args.seconds
        print(f"MICROPHONE OPEN for at most {maximum} seconds, including warm-up. Remain quiet.", flush=True)
        timer = threading.Timer(maximum, expire)
        timer.daemon = True
        timer.start()
        capture.start()
        try:
            capture.wait_ready()
        except Exception:
            print(json.dumps({"warmupFailure": gate.snapshot()}), flush=True)
            raise
        while True:
            if stopped.is_set() or failed.is_set():
                raise readiness_error("Capture stopped during warm-up")
            if time.monotonic() >= deadline:
                raise readiness_error("Input did not settle within five seconds")
            capture.health()
            if not gate.ready.wait(0.02):
                continue
            if time.monotonic() >= deadline:
                raise readiness_error("Warm-up deadline expired")
            summary = gate.arm()
            if summary is not None:
                break
        print(json.dumps({"warmup": summary}), flush=True)
        if warmup_only:
            print(json.dumps({"warmupDiagnostics": gate.snapshot()}), flush=True)
            return
        threading.Thread(target=recognize, daemon=True, name="continuous-asr").start()
        if agent:
            threading.Thread(target=synthesize, daemon=True, name="agent-synthesis").start()
        speaker.play(tone, "demo")
        print("READY: speak after the beep, without a wake word. Wait for a response, then interrupt it.", flush=True)
        next_health = time.monotonic()
        while not stopped.is_set():
            try:
                event = events.get(timeout=0.05)
            except queue.Empty:
                event = None
            if event:
                kind = event["type"]
                if kind == "onset":
                    tokens[event["id"]] = event["generation"]
                    print(json.dumps({"event": "speech_started", "turn": event["id"]}), flush=True)
                elif kind == "endpoint":
                    generation = tokens.pop(event["id"], None)
                    exchange.endpoint(generation)
                    if generation is not None and event["pcm"] and not event["truncated"]:
                        try:
                            jobs.put_nowait({"turn": event["id"], "generation": generation,
                                             "pcm": event["pcm"]})
                        except queue.Full:
                            raise RuntimeError("Recognition queue overflow; stopping instead of losing requests") from None
                elif kind == "truncated":
                    print("Utterance exceeded twelve seconds; discarded through its endpoint.", flush=True)
                elif kind == "recognized":
                    completed += 1
                    possible_echo = owned_echo(event["text"])
                    submit = bool(agent and event["text"].strip() and not possible_echo)
                    result = {"event": "heard", "turn": event["turn"],
                              "asrMs": round(event["asrMs"], 1),
                              "dispatch": "pending" if submit else False,
                              "superseded": event["generation"] != exchange.generation,
                              "possibleEcho": possible_echo}
                    if args.show_text:
                        result["text"] = event["text"]
                    print(json.dumps(result), flush=True)
                    if submit:
                        agent.submit(event["generation"], event["text"])
                    if completed >= 20:
                        print("Twenty-turn safety limit reached; ending the test.", flush=True)
                        stopped.set()
                    elif not agent:
                        with exchange.lock:
                            if exchange.can_reply(event["generation"], event["text"]):
                                speaker.play(response, "demo")
                elif kind == "agent_answer":
                    print(json.dumps({"event": "agent_reply_received", "generation": event["generation"]}), flush=True)
                    if exchange.can_reply(event["generation"], event["text"]):
                        try:
                            speech_jobs.put_nowait({"generation": event["generation"], "text": event["text"]})
                        except queue.Full:
                            raise RuntimeError("Agent speech queue overflow") from None
                    else:
                        print(json.dumps({"event": "agent_reply_discarded", "stage": "before_synthesis",
                                          "generation": event["generation"],
                                          "currentGeneration": exchange.generation,
                                          "inputActive": exchange.active}), flush=True)
                elif kind == "agent_audio":
                    print(json.dumps({"event": "agent_synthesis_complete", "generation": event["generation"],
                                      "renderMs": event["renderMs"]}), flush=True)
                    with exchange.lock:
                        if exchange.can_reply(event["generation"], event["text"]):
                            spoken.append(re.findall(r"[a-z]+", event["text"].lower()))
                            del spoken[:-4]
                            speaker.play(event["pcm"], "demo", ident=f"agent-{event['generation']}")
                            print(json.dumps({"event": "agent_playback_queued", "generation": event["generation"]}), flush=True)
                        else:
                            print(json.dumps({"event": "agent_reply_discarded", "stage": "after_synthesis",
                                              "generation": event["generation"],
                                              "currentGeneration": exchange.generation,
                                              "inputActive": exchange.active}), flush=True)
                elif kind == "agent_status":
                    print(json.dumps({"event": "agent_reply_status", "stage": event["stage"],
                                      "reason": event["reason"], "generation": event.get("generation")}), flush=True)
                elif kind == "played" and str(event.get("id", "")).startswith("agent-"):
                    print(json.dumps({"event": "agent_playback_drained", "id": event["id"],
                                      "acousticPlaybackVerified": False}), flush=True)
                elif kind == "agent_accepted":
                    print(json.dumps({"event": "agent_accepted", "sequence": event["sequence"],
                                      "executionConfirmed": False}), flush=True)
                elif kind == "interrupt":
                    print(json.dumps({"event": "interruption_processed", "processMs": round(event["processMs"], 1),
                                      "playbackWasActive": event["playbackWasActive"],
                                      "acousticLatencyMeasured": False}), flush=True)
                elif kind == "fault":
                    fail()
                event.clear()
            if busy[0] is not None and time.monotonic() - busy[0] > 10:
                raise RuntimeError("Recognition exceeded ten seconds")
            if synthesis_busy[0] is not None and time.monotonic() - synthesis_busy[0] > 10:
                raise RuntimeError("Synthesis exceeded ten seconds")
            if time.monotonic() >= next_health:
                graph.check()
                capture.health()
                sink.health()
                next_health = time.monotonic() + 1
        if failed.is_set():
            raise RuntimeError("Continuous trial stopped on audio, agent connection, or inference failure")
    finally:
        stopped.set()
        exchange.close()
        errors = []
        if timer:
            try:
                timer.cancel()
                timer.join(timeout=2)
                if timer.is_alive():
                    errors.append("watchdog")
            except Exception:
                errors.append("watchdog")
        errors += close_owned((("gate", gate), ("capture", capture), ("speaker", speaker),
                               ("sink", sink), ("audio_lock", audio_lock), ("agent", agent)))
        for pending in (events, jobs, speech_jobs):
            if pending is None:
                continue
            while True:
                try:
                    pending.get_nowait().clear()
                except queue.Empty:
                    break
        tokens.clear()
        spoken.clear()
        print("Cleanup incomplete; exit this process." if errors else
              "MICROPHONE CLOSED. Test finished; no audio files saved.", flush=True)
        if agent:
            print("Pi processing may continue. Its tool guard stays enabled until /voice-trial release.", flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--run", action="store_true")
    parser.add_argument("--bundle", default=os.environ.get("PAJ_VOICE_SPEECH_BUNDLE"))
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--show-text", action="store_true")
    parser.add_argument("--warmup-only", action="store_true")
    parser.add_argument("--agent", action="store_true")
    parser.add_argument("--agent-socket")
    parser.add_argument("--session")
    args = parser.parse_args(argv)
    if not 15 <= args.seconds <= 120:
        parser.error("Choose 15-120 seconds")
    if args.run and (not args.input or not args.output or not sys.stdin.isatty()):
        parser.error("--run requires exact input/output names and an interactive terminal")
    if args.warmup_only and (args.agent or not args.run):
        parser.error("--warmup-only requires --run without any agent connection")
    if args.agent != bool(args.agent_socket and args.session) or (args.agent and not args.run):
        parser.error("Agent mode requires --run, --agent, --agent-socket and an exact --session")
    if not args.agent and (args.agent_socket or args.session):
        parser.error("Socket/session arguments require explicit --agent mode")
    try:
        root = model_bundle(args.bundle, classifier=False)
        print("Loading only local speech models; microphone remains closed.", flush=True)
        inference = Inference(root, classify=False)
        if args.check:
            inference.synthesize(RESPONSE)
            print("Speech models and local synthesis ready. Classifier disabled; no capture or playback opened.")
        elif args.agent:
            from .agent_link import AgentLink
            link = AgentLink(args.agent_socket, args.session)
            try:
                trial(args, inference, link)
            finally:
                link.close()
        else:
            trial(args, inference)
        return 0
    except (KeyboardInterrupt, EOFError):
        return 130
    except Exception as error:
        print(f"Continuous test stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
