"""Experimental local voice lab. Agent dispatch is deliberately unavailable."""

import argparse
import json
import os
from pathlib import Path
import queue
import select
import sys
import threading
import time

from .lab_session import AdmissionSession
from .speech import SpeechInference


def close_owned(resources):
    failed = []
    for name, resource in resources:
        if resource is not None:
            try:
                resource.close()
            except Exception:
                failed.append(name)
    return failed


def model_bundle(value, classifier=True):
    if not value:
        raise ValueError("Enter the project nix-shell to select packaged models")
    root = Path(value)
    if not root.is_absolute() or not root.is_dir():
        raise ValueError("Model bundle must be an existing absolute directory")
    required = ["stt/model.bin", "stt/config.json", "stt/tokenizer.json",
                "tts/model.onnx", "tts/model.onnx.json"]
    if classifier:
        required.append("classifier/config.json")
    for name in required:
        if not (root / name).is_file():
            raise ValueError("Incomplete packaged model bundle")
    return root


class Inference(SpeechInference):
    def __init__(self, root, speech=True, classify=True):
        for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY",
                     "DO_NOT_TRACK"):
            os.environ[name] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        self.backend = "disabled"
        self.classifier = None
        if classify:
            self.backend = os.environ.get("PAJ_VOICE_CLASSIFIER", "gliclass")
            if self.backend == "gliner2":
                from .lab_classifier import Classifier
            elif self.backend == "gliclass":
                from .lab_gliclass import Classifier
            else:
                raise ValueError("Unknown packaged classifier backend")
            self.classifier = Classifier(root / "classifier")
        if speech:
            super().__init__(root)


def show_effects(effects, show_text=False):
    for effect in effects:
        if effect["type"] == "admit":
            result = {"event": "would_send", "dispatch": False}
            if show_text:
                result["text"] = effect["text"]
            print(json.dumps(result), flush=True)
        elif effect["type"] == "discard":
            print(json.dumps({"event": "discarded", "reason": effect["reason"]}), flush=True)


def text_trial(args, inference):
    session = AdmissionSession(time.monotonic)
    session.arm()
    token = session.onset(session.epoch)
    session.end(token)
    context = {"active_agents": args.agent, "last_question": None, "responding": False}
    result = inference.classifier.classify(args.text, context)
    decision = "uncertain" if args.force_confirm else result["decision"]
    print(json.dumps({"decision": decision, "classifierMs": result["elapsedMs"],
                      "forcedConfirmation": args.force_confirm}), flush=True)
    effects = session.submit(token, args.text, decision)
    show_effects(effects, args.show_accepted_text)
    for effect in effects:
        if effect["type"] != "prompt":
            continue
        if not sys.stdin.isatty():
            show_effects(session.reset("non_interactive"), args.show_accepted_text)
            print("Typed confirmation requires an interactive terminal; candidate discarded.", flush=True)
            continue
        print(effect["text"] + " Reply yes/of course within six seconds:", flush=True)
        session.prompt_complete(effect["id"], effect["epoch"], True)
        if select.select([sys.stdin], [], [], 6)[0]:
            reply = sys.stdin.readline(4097)
            token = session.onset(session.epoch)
            session.end(token)
            show_effects(session.submit(token, reply, "reject"), args.show_accepted_text)
        else:
            show_effects(session.tick(), args.show_accepted_text)
    session.off()


def self_test(inference):
    np = inference.np

    def synthetic(text):
        pcm = inference.synthesize(text, deterministic=True)
        samples = np.frombuffer(pcm, dtype="<i2")
        count = int(len(samples) * 16000 / inference.rate)
        wave = np.interp(np.arange(count) * inference.rate / 16000,
                         np.arange(len(samples)), samples).astype("<i2").tobytes()
        return b"\0" * 16000 + wave + b"\0" * 25600

    body, body_ms = inference.transcribe(synthetic("What is the status of the Nix agent?"))
    if not body:
        raise RuntimeError("Synthetic command transcription was empty")
    classified = inference.classifier.classify(body, {"active_agents": ["nix"]})
    trials = []
    for reply, expected in (("Yes", True), ("Of course", True), ("No", False)):
        session = AdmissionSession(time.monotonic)
        session.arm()
        token = session.onset(session.epoch)
        session.end(token)
        prompt = session.submit(token, body, "uncertain")[0]
        session.prompt_complete(prompt["id"], prompt["epoch"], True)
        audio = synthetic(reply)
        token = session.onset(session.epoch)
        session.end(token)
        text, elapsed = inference.transcribe(audio)
        effects = session.submit(token, text, "reject")
        admitted = [item["text"] for item in effects if item["type"] == "admit"]
        success = admitted == ([body] if expected else []) and session.phase == "listening"
        trials.append({"syntheticReply": reply, "recognizedReply": text,
                       "passed": success, "asrMs": round(elapsed, 1)})
        session.off()
    result = {"syntheticOnly": True, "synthesis": "deterministic-zero-noise",
              "outputDrainSimulated": True, "dispatch": False,
              "forcedConfirmation": True, "bodyAsrMs": round(body_ms, 1),
              "recognizedSyntheticBody": body,
              "classifier": inference.backend,
              "classifierDecision": classified["decision"],
              "classifierMs": round(classified["elapsedMs"], 1), "trials": trials}
    print(json.dumps(result, indent=2), flush=True)
    if not all(row["passed"] for row in trials):
        raise RuntimeError("Synthetic confirmation failed; inspect results before live qualification")


def live_trial(args, inference):
    from pysilero_vad import SileroVoiceActivityDetector
    from .cli import AudioLock
    from .devices import Graph, PipeSink
    from .lab_audio import LabCapture, Segments, Speaker

    graph = Graph()
    source, target = graph.bind(args.input, args.output)
    if source.name.startswith("bluez"):
        raise ValueError("Use the internal microphone, not the Bluetooth headset microphone")
    prompt_pcm = inference.synthesize("Was that message for me?")
    demo_pcm = inference.synthesize(
        "This is a local playback demonstration. Nothing you say will execute a command. "
        "You can speak over this demonstration to test how quickly playback pauses. "
        "This is a local playback demonstration. Nothing you say will execute a command. "
        "You can speak over this demonstration to test how quickly playback pauses."
    ) if args.playback_demo else None
    samples = inference.np.arange(int(inference.rate * 0.1))
    cue_pcm = (inference.np.sin(2 * inference.np.pi * 800 * samples / inference.rate)
               * 1200).astype("<i2").tobytes()
    session = AdmissionSession(time.monotonic)
    events, jobs = queue.Queue(maxsize=64), queue.Queue(maxsize=2)
    stopped = threading.Event()
    faulted = threading.Event()
    cue = None
    serial = 0
    tokens = {}
    capture = speaker = segments = audio_lock = timer = None

    def fail(error=None):
        faulted.set()
        stopped.set()

    def emit(frame):
        try:
            if frame["type"] == "onset":
                frame["ignore"] = cue is not None
            events.put_nowait(frame)
        except queue.Full:
            fail()

    def expire():
        stopped.set()
        if close_owned((("capture", capture), ("speaker", speaker))):
            faulted.set()

    def effects(items):
        nonlocal cue, serial
        show_effects(items, args.show_accepted_text)
        for item in items:
            if item["type"] == "prompt":
                print("Local confirmation question; answer only after it finishes.", flush=True)
                speaker.play(prompt_pcm, "prompt", item["id"], item["epoch"])
            elif item["type"] == "discard":
                if speaker.active and speaker.active["kind"] == "prompt":
                    speaker.cancel()
                    segments.clear_preroll()
            elif item["type"] == "resume":
                speaker.resume()
            elif item["type"] == "admit":
                speaker.cancel()
                speaker.discard()
                serial += 1
                cue = serial
                speaker.play(cue_pcm, "cue", serial, session.epoch)

    def recognize():
        while not stopped.is_set():
            try:
                job = jobs.get(timeout=0.1)
            except queue.Empty:
                continue
            text = None
            try:
                if job["epoch"] != session.epoch:
                    continue
                text, asr_ms = inference.transcribe(job.pop("pcm"))
                if stopped.is_set():
                    return
                if job["confirmation"] or not text:
                    decision, classifier_ms = "reject", 0
                else:
                    result = inference.classifier.classify(text, {
                        "active_agents": args.agent, "last_question": None,
                        "responding": job["responding"],
                    })
                    decision, classifier_ms = result["decision"], result["elapsedMs"]
                    if args.force_confirm:
                        decision = "uncertain"
                if stopped.is_set() or job["epoch"] != session.epoch:
                    continue
                emit({"type": "recognized", "token": job["token"], "text": text,
                      "decision": decision, "asrMs": asr_ms, "classifierMs": classifier_ms})
            except Exception:
                fail()
                return
            finally:
                text = None
                job.clear()

    try:
        audio_lock = AudioLock()
        sink = PipeSink(graph.paths["pw-play"], target, inference.rate)
        speaker = Speaker(sink, emit)
        segments = Segments(emit, speaker.pause, lambda: session.epoch)
        capture = LabCapture(graph.paths["pw-record"], source, SileroVoiceActivityDetector,
                             0.001, segments, fail)
        print("EXPERIMENTAL: no agent connection or dispatch. Headphones required.", flush=True)
        print(f"Microphone opens in 3 seconds for at most {args.seconds} seconds. Ctrl-C stops it.",
              flush=True)
        time.sleep(3)
        session.arm()
        print("MICROPHONE OPEN. Wait for READY.", flush=True)
        timer = threading.Timer(args.seconds, expire)
        timer.daemon = True
        timer.start()
        capture.start()
        capture.wait_ready()
        started = time.monotonic()
        print("READY. Speech is processed locally; accepted-text display is "
              + ("ON." if args.show_accepted_text else "OFF."), flush=True)
        threading.Thread(target=recognize, daemon=True, name="lab-recognition").start()
        if demo_pcm:
            speaker.play(demo_pcm, "demo")
        next_health = time.monotonic()
        while not stopped.is_set():
            try:
                event = events.get(timeout=0.05)
            except queue.Empty:
                event = None
            if event:
                kind = event["type"]
                if kind == "onset":
                    token = None if event["ignore"] else session.onset(event["epoch"], event["at"])
                    tokens[event["id"]] = (token, session.phase)
                elif kind == "truncated":
                    effects(session.reset("truncated"))
                    print("Utterance too long; discarded until silence.", flush=True)
                elif kind == "endpoint":
                    token, phase = tokens.pop(event["id"], (None, None))
                    effects(session.end(token))
                    if event["truncated"]:
                        speaker.resume()
                    if (not event["truncated"] and event["pcm"] and token is not None
                            and phase in ("capturing", "confirm_capturing")
                            and session.phase in ("recognizing", "confirm_recognizing")):
                        jobs.put_nowait({"token": token, "epoch": session.epoch, "pcm": event["pcm"],
                                         "confirmation": phase == "confirm_capturing",
                                         "responding": speaker.saved is not None})
                elif kind == "recognized":
                    before = session.phase
                    effects(session.submit(event["token"], event["text"], event["decision"]))
                    print(json.dumps({"event": "recognition", "phase": before,
                                      "decision": event["decision"],
                                      "asrMs": round(event["asrMs"], 1),
                                      "classifierMs": round(event["classifierMs"], 1)}), flush=True)
                elif kind == "played":
                    if event["kind"] == "prompt":
                        was_prompt = session.phase == "prompt"
                        effects(session.prompt_complete(event["id"], event["epoch"], True))
                        if was_prompt and session.phase == "confirming":
                            segments.clear_preroll()
                            print("Confirmation window: six seconds to start your reply.", flush=True)
                    elif event["kind"] == "cue" and event["id"] == cue:
                        segments.clear_preroll()
                        cue = None
                elif kind == "paused":
                    print(json.dumps({"event": "playback_abort_completed",
                                      "processMs": round(event["elapsedMs"], 1),
                                      "acousticLatencyMeasured": False}), flush=True)
                elif kind == "fault":
                    fail()
                event.clear()
            effects(session.tick())
            if time.monotonic() >= next_health:
                graph.check()
                capture.health()
                sink.health()
                next_health = time.monotonic() + 1
        if faulted.is_set():
            raise RuntimeError("Trial stopped on audio or inference failure")
        print(json.dumps({"event": "trial_finished", "dispatch": False,
                          "seconds": round(time.monotonic() - started, 1)}), flush=True)
    finally:
        stopped.set()
        session.off()
        if timer:
            timer.cancel()
        cleanup_failed = close_owned((("capture", capture), ("segments", segments),
                                      ("speaker", speaker), ("audio_lock", audio_lock)))
        while True:
            try:
                item = jobs.get_nowait()
                item.clear()
            except queue.Empty:
                break
        while True:
            try:
                item = events.get_nowait()
                item.clear()
            except queue.Empty:
                break
        tokens.clear()
        if cleanup_failed:
            print("Audio cleanup incomplete; exit the lab process. No commands executed.", flush=True)
        else:
            print("MICROPHONE CLOSED. No commands executed; no audio or transcript files saved.",
                  flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Load packaged models without opening audio")
    mode.add_argument("--self-test", action="store_true", help="Synthetic speech/confirmation test; no devices")
    mode.add_argument("--text", help="Classify an explicit text and locally confirm uncertainty")
    mode.add_argument("--live", action="store_true", help="Explicitly open a bounded commands-disabled trial")
    parser.add_argument("--bundle", default=os.environ.get("PAJ_VOICE_MODEL_BUNDLE"))
    parser.add_argument("--input", help="Exact internal microphone PipeWire node.name")
    parser.add_argument("--output", help="Exact headphone PipeWire node.name")
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--agent", action="append", default=[], help="Synthetic active agent name; no Pi lookup")
    parser.add_argument("--playback-demo", action="store_true")
    parser.add_argument("--force-confirm", action="store_true", help="Exercise confirmation, not model accuracy")
    parser.add_argument("--show-accepted-text", action="store_true", help="Opt in to accepted text in terminal")
    args = parser.parse_args(argv)
    if not 15 <= args.seconds <= 180:
        parser.error("--seconds must be between 15 and 180")
    if args.live and (not args.input or not args.output):
        parser.error("--live requires explicit --input and --output; no default-device fallback")
    try:
        root = model_bundle(args.bundle)
        print("Loading packaged local models; no microphone access during loading.", flush=True)
        inference = Inference(root, speech=args.text is None)
        if args.check:
            print(json.dumps({"ready": True, "modelLoadOnly": True, "hardwareQualified": False,
                              "dispatch": False, "classifier": inference.backend,
                              "classifierLoadMs": inference.classifier.load_ms}),
                  flush=True)
        elif args.self_test:
            self_test(inference)
        elif args.text is not None:
            text_trial(args, inference)
        else:
            live_trial(args, inference)
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(f"Lab stopped ({type(error).__name__}): {error}. No agent commands executed.",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
