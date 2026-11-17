"""Paired, RAM-only STT evaluation. No classifier or dispatch; optional recording replay."""

import argparse
import array
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time

from .core import Turns
from .lab_audio import LabCapture, Segments
from .input_ready import InputReady


PROMPTS = (
    ("silence", "", "Remain silent for this window."),
    ("yes", "Yes", "Say: Yes."),
    ("no", "No", "Say: No."),
    ("of-course", "Of course", "Say: Of course."),
    ("qualified-yes", "Yes but do not send it", "Say: Yes, but do not send it."),
    ("agent-status", "What is the status of the Nix agent", "Say: What is the status of the Nix agent?"),
    ("tests", "Please review the tests and tell me what failed", "Say: Please review the tests and tell me what failed."),
    ("partner", "What is for dinner", "Say: What's for dinner?"),
    ("pause", "Stop listening for five minutes", "Say: Stop listening for five minutes."),
)


def words(text):
    text = text.lower().replace("what's", "what is").replace("don't", "do not")
    return re.findall(r"[a-z0-9]+", text)


def score(reference, text):
    expected, actual = words(reference), words(text)
    row = list(range(len(actual) + 1))
    for i, left in enumerate(expected, 1):
        following = [i]
        for j, right in enumerate(actual, 1):
            following.append(min(row[j] + 1, following[j - 1] + 1,
                                 row[j - 1] + (left != right)))
        row = following
    return {"exact": expected == actual, "wordEdits": row[-1],
            "referenceWords": len(expected),
            "wer": row[-1] / len(expected) if expected else None}


class Recording:
    def __init__(self, seconds):
        self.limit = int((seconds + 0.1) * 32000)
        self.frames = []
        self.size = 0
        self.lock = threading.RLock()
        self.closed = False

    def feed(self, pcm, voiced, captured_at=None):
        with self.lock:
            if self.closed:
                return
            if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2:
                raise ValueError("Invalid S16 capture frame")
            if self.size + len(pcm) > self.limit:
                raise RuntimeError("Recording exceeded RAM bound")
            self.frames.append((pcm, bool(voiced)))
            self.size += len(pcm)

    def close(self):
        with self.lock:
            self.closed = True

    def clear(self):
        with self.lock:
            self.closed = True
            self.frames.clear()
            self.size = 0


def paths(recording):
    now = [0.0]
    lab_parts = []
    legacy_parts = []

    def emit(event):
        if event["type"] == "endpoint" and not event["truncated"]:
            lab_parts.append(event["pcm"])

    lab = Segments(emit, lambda: None, lambda: 0, clock=lambda: now[0])
    production = Turns({"silenceMs": 1200, "maxSeconds": 45, "prefixIntervalMs": 500},
                       ["paj"], None, None, lambda event: None, None,
                       clock=lambda: now[0], start_worker=False)
    try:
        for pcm, voiced in recording.frames:
            now[0] += len(pcm) / 32000
            lab.feed(pcm, voiced, captured_at=now[0])
            production.feed(pcm, voiced)
            while production.finals:
                turn = production.finals.popleft()
                legacy_parts.append(bytes(turn.pcm))
                production.turns.pop(turn.id)
                turn.pcm.clear()
        result = {
            "full": {"pcm": [b"".join(pcm for pcm, _ in recording.frames)], "unfinished": False},
            "lab": {"pcm": lab_parts, "unfinished": lab.current is not None},
            "production": {"pcm": legacy_parts, "unfinished": production.current is not None},
        }
    finally:
        lab.close()
        production.close()
    return result


def levels(recording):
    total = clipped = energy = peak = voiced = 0
    for pcm, speech in recording.frames:
        samples = array.array("h", pcm)
        voiced += int(speech)
        total += len(samples)
        clipped += sum(abs(value) >= 32760 for value in samples)
        energy += sum(value * value for value in samples)
        peak = max(peak, max(abs(value) for value in samples))
    return {"audioSeconds": total / 16000, "frames": len(recording.frames),
            "voicedFrames": voiced, "peak": peak / 32768,
            "rms": math.sqrt(energy / total) / 32768 if total else 0,
            "clippedSamples": clipped, "clipFraction": clipped / total if total else 0}


def level_trace(recording, bucket_samples=4000):
    samples = array.array("h", b"".join(pcm for pcm, _ in recording.frames))
    result = []
    for start in range(0, len(samples), bucket_samples):
        block = samples[start:start + bucket_samples]
        result.append({
            "start": start / 16000, "end": (start + len(block)) / 16000,
            "peak": max(abs(value) for value in block) / 32768,
            "rms": math.sqrt(sum(value * value for value in block) / len(block)) / 32768,
            "mean": sum(block) / len(block) / 32768,
            "clipFraction": sum(abs(value) >= 32760 for value in block) / len(block),
        })
    return result


def input_state(graph, source):
    entry = next(item for item in graph.snapshot()
                 if item.get("info", {}).get("props", {}).get("node.name") == source.name)
    props = entry["info"].get("params", {}).get("Props", [])
    return {"state": entry["info"].get("state"),
            "levels": [{key: value for key, value in item.items()
                        if key in ("mute", "channelVolumes", "softMute", "softVolumes")}
                       for item in props if "channelVolumes" in item]}


def close_all(resources):
    failed = []
    for resource in resources:
        if resource is not None:
            try:
                resource.close()
            except Exception:
                failed.append(type(resource).__name__)
    return failed


def capture_window(graph, source, seconds, recording, *, silent=False, warmup=True):
    from pysilero_vad import SileroVoiceActivityDetector
    from .cli import AudioLock

    stopped = threading.Event()
    failed = threading.Event()
    capture = audio_lock = None
    timers = []
    receiver = InputReady(recording) if warmup else recording

    def fault(error):
        failed.set()
        stopped.set()

    def expire():
        receiver.close()
        stopped.set()
        if close_all((capture,)):
            failed.set()

    try:
        audio_lock = AudioLock()
        capture = LabCapture(graph.paths["pw-record"], source, SileroVoiceActivityDetector,
                             0.001, receiver, fault)
        graph.check()
        maximum = seconds + 5 if warmup else seconds
        stage = "including warm-up" if warmup else "raw startup diagnostic"
        print(f"MICROPHONE OPEN for at most {maximum} seconds ({stage}). Remain quiet.", flush=True)
        deadline = time.monotonic() + 5
        timer = threading.Timer(maximum, expire)
        timer.daemon = True
        timers.append(timer)
        timer.start()
        capture.start()
        capture.wait_ready()
        if warmup:
            print("WARMING UP: waiting for stable, quiet input; warm-up audio is discarded.", flush=True)
            while True:
                if failed.is_set() or stopped.is_set():
                    raise RuntimeError("Capture ended before input became ready")
                if time.monotonic() >= deadline:
                    raise RuntimeError("Input did not settle within five seconds; no speech recorded")
                capture.health()
                if not receiver.ready.wait(0.02):
                    continue
                if time.monotonic() >= deadline or stopped.is_set() or failed.is_set():
                    raise RuntimeError("Input readiness deadline expired; no speech recorded")
                summary = receiver.arm()
                if summary is not None:
                    break
            print(json.dumps({"warmup": summary}), flush=True)
            timer = threading.Timer(seconds, expire)
            timer.daemon = True
            timers.append(timer)
            timer.start()
        print("RECORDING SILENCE. Remain quiet." if silent
              else "SPEAK NOW. Say the phrase once, then remain quiet.", flush=True)
        next_health = time.monotonic()
        while not stopped.wait(0.05):
            capture.health()
            if time.monotonic() >= next_health:
                graph.check()
                next_health = time.monotonic() + 0.5
        if failed.is_set():
            raise RuntimeError("Capture failed; no recognition will run")
    finally:
        receiver.close()
        errors = []
        for timer in timers:
            try:
                timer.cancel()
                timer.join(timeout=2)
                if timer.is_alive():
                    errors.append("capture watchdog")
            except Exception:
                errors.append("capture watchdog")
        errors.extend(close_all((capture, audio_lock)))
        if errors:
            print("Audio shutdown incomplete; exit this evaluation.", file=sys.stderr)
            if sys.exc_info()[0] is None:
                raise RuntimeError("Audio shutdown failed; no recognition will run")
        else:
            print("MICROPHONE CLOSED. Recognition runs only after capture has stopped.", flush=True)
    if failed.is_set():
        raise RuntimeError("Capture failed; no recognition will run")


def replay(recording, graph, target):
    from .devices import PipeSink

    print("Replaying the RAM recording through the selected headphones; microphone is closed.", flush=True)
    graph.check()
    sink = PipeSink(graph.paths["pw-play"], target, 16000)
    try:
        for pcm, _ in recording.frames:
            sink.write(pcm, lambda: True)
        sink.drain(lambda: True)
    finally:
        sink.close()


class Recognizer:
    def __init__(self, path):
        for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY",
                    "DO_NOT_TRACK"):
            os.environ[key] = "1"
        model = Path(path)
        if not model.is_absolute() or any(not (model / name).is_file()
                                         for name in ("model.bin", "config.json", "tokenizer.json")):
            raise ValueError("Select the packaged absolute Whisper model directory")
        import numpy as np
        from faster_whisper import WhisperModel

        self.np = np
        self.model = WhisperModel(str(model), device="cpu", compute_type="int8",
                                  cpu_threads=2, num_workers=1, local_files_only=True)

    def transcribe(self, pcm):
        samples = self.np.frombuffer(pcm, dtype="<i2").astype(self.np.float32) / 32768
        started = time.perf_counter()
        segments, _ = self.model.transcribe(samples, language="en", beam_size=1, temperature=0,
                                            condition_on_previous_text=False, vad_filter=False)
        text = "".join(segment.text for segment in segments).strip()
        return text, (time.perf_counter() - started) * 1000


def evaluate(recording, recognizer, reference, budget):
    if not recording.size:
        raise RuntimeError("No PCM captured; no recognition will run")
    report = {"levels": levels(recording), "paths": {}}
    candidates = paths(recording)
    required = sum(len(candidate["pcm"]) for candidate in candidates.values())
    if any(len(candidate["pcm"]) > 4 for candidate in candidates.values()) or required > budget[0]:
        raise RuntimeError("Recognition budget exceeded; audio discarded")
    for name, candidate in candidates.items():
        pieces, elapsed = [], 0
        for pcm in candidate["pcm"]:
            budget[0] -= 1
            text, compute_ms = recognizer.transcribe(pcm)
            pieces.append(text)
            elapsed += compute_ms
        report["paths"][name] = {
            "segments": pieces, "audioSeconds": [len(pcm) / 32000 for pcm in candidate["pcm"]],
            "unfinished": candidate["unfinished"], "computeMs": round(elapsed, 1),
            "isolatedYesInQualifiedReply": (words(reference)[:1] == ["yes"]
                                            and len(words(reference)) > 1
                                            and any(words(piece) == ["yes"] for piece in pieces)),
            **score(reference, " ".join(pieces)),
        }
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Load STT and VAD without opening audio")
    mode.add_argument("--run", action="store_true", help="Explicit interactive microphone evaluation")
    parser.add_argument("--levels-only", action="store_true",
                        help="Two silent capture windows, level trace only; no Whisper")
    parser.add_argument("--model", default=os.environ.get("PAJ_VOICE_STT_MODEL"))
    parser.add_argument("--input", help="Exact internal-microphone PipeWire node name")
    parser.add_argument("--replay", action="store_true", help="Replay each RAM recording after mic closes")
    parser.add_argument("--output", help="Exact headphone PipeWire node name for optional replay")
    parser.add_argument("--window", type=int, default=7, choices=range(5, 11))
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--quick", action="store_true", help="Silence, yes, no, of course, agent status")
    selection.add_argument("--phrase", choices=[item[0] for item in PROMPTS],
                           help="Evaluate just one displayed phrase")
    parser.add_argument("--require-exact", action="store_true",
                        help="Exit nonzero if lab segmentation misses a reference or splits qualified yes")
    args = parser.parse_args(argv)
    if args.levels_only and not args.run:
        parser.error("--levels-only requires explicit --run")
    if args.levels_only and (args.require_exact or args.phrase):
        parser.error("Phrase selection and exact-word checks do not apply to levels-only diagnostics")
    if not args.model and not args.levels_only:
        parser.error("Use the project STT evaluation package")
    if args.replay and not args.output:
        parser.error("--replay requires an explicit headphone --output")
    if args.run and (not args.input or not sys.stdin.isatty()):
        parser.error("--run needs an explicit input and interactive terminal")
    recording = None
    try:
        recognizer = None if args.levels_only else Recognizer(args.model)
        from pysilero_vad import SileroVoiceActivityDetector

        SileroVoiceActivityDetector()
        if args.check:
            print("Packaged Whisper and VAD loaded. No microphone opened; no classifier imported.")
            return 0
        from .devices import Graph, select_node

        graph = Graph()
        source = select_node(graph.snapshot(), args.input, "Audio/Source")
        if source.name.startswith("bluez"):
            raise ValueError("Use the internal microphone, not a Bluetooth headset microphone")
        target = select_node(graph.snapshot(), args.output, "Audio/Sink") if args.replay else None
        graph.bound = (source, target) if target else (source,)
        prompts = PROMPTS[:4] + PROMPTS[5:6] if args.quick else PROMPTS
        if args.phrase:
            prompts = tuple(item for item in PROMPTS if item[0] == args.phrase)
        if args.levels_only:
            prompts = (("silence-1", "", "Remain silent; leave the room/game setup unchanged."),
                       ("silence-2", "", "Remain silent again; do not change input settings."))
        budget = [36]
        matched = {"full": 0, "lab": 0, "production": 0}
        failures = []
        print("No classifier, TTS, agent connection, commands, gain changes, or audio files.")
        if args.replay:
            print("Optional replay is enabled: each RAM recording will play after the microphone closes.")
        if args.levels_only:
            print("LEVELS ONLY: Whisper is not loaded; only numeric audio diagnostics will be printed.")
        else:
            print("Requested speech and any incidental speech in each window will appear in terminal scrollback.")
        print("Do not redirect output if you do not want transcript files. Ctrl-C exits and releases RAM.")
        for ident, reference, instruction in prompts:
            if budget[0] < 3:
                raise RuntimeError("Recognition call budget exhausted")
            print(f"\n[{ident}] {instruction}", flush=True)
            input("Press Enter to consent to this microphone window, or Ctrl-C to stop: ")
            print("Microphone opens in two seconds. "
                  + ("Remain silent." if not reference else "Wait for SPEAK NOW."), flush=True)
            time.sleep(2)
            recording = Recording(args.window)
            try:
                if args.levels_only:
                    print(json.dumps({"inputBeforeCapture": input_state(graph, source)}), flush=True)
                capture_window(graph, source, args.window, recording, silent=not bool(reference),
                               warmup=not args.levels_only)
                if args.replay:
                    replay(recording, graph, target)
                if args.levels_only:
                    print(json.dumps({"phrase": ident, "inputAfterCapture": input_state(graph, source),
                                      "levels": levels(recording)}, indent=2))
                    print("seconds      peak     rms      mean     clipped")
                    for item in level_trace(recording):
                        print(f"{item['start']:4.2f}-{item['end']:4.2f}  "
                              f"{item['peak']:7.4f} {item['rms']:7.4f} "
                              f"{item['mean']:+8.4f} {item['clipFraction'] * 100:6.2f}%")
                    continue
                report = evaluate(recording, recognizer, reference, budget)
                print(json.dumps({"phrase": ident, "expected": reference, **report}, indent=2), flush=True)
                for name, result in report["paths"].items():
                    matched[name] += int(result["exact"] and not result["unfinished"])
                lab = report["paths"]["lab"]
                if not lab["exact"] or lab["unfinished"] or lab["isolatedYesInQualifiedReply"]:
                    failures.append(ident)
            finally:
                recording.clear()
                recording = None
        if args.levels_only:
            print("Level check complete; audio discarded. No speech recognition ran.")
            return 0
        print(json.dumps({"evaluationComplete": True, "phrases": len(prompts),
                          "normalizedExactMatches": matched, "labFailureIds": failures,
                          "dispatch": False, "qualified": False}, indent=2))
        print("Audio discarded. These word scores do not certify meaning or reliability.")
        return int(args.require_exact and bool(failures))
    except (KeyboardInterrupt, EOFError):
        print("Evaluation stopped; no audio is retained.")
        return 130
    except Exception as error:
        print(f"Evaluation stopped: {error}", file=sys.stderr)
        return 1
    finally:
        if recording is not None:
            recording.clear()


if __name__ == "__main__":
    raise SystemExit(main())
