import json
import re

from .devices import Node


def monitor_arguments(source: Node, sink: Node, name="paj_voice_source"):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", name):
        raise ValueError("An unambiguous echo source name is required")
    for node, kind in ((source, "Audio/Source"), (sink, "Audio/Sink")):
        if (
            node.kind != kind
            or not isinstance(node.serial, str)
            or not node.serial.isascii()
            or not node.serial.isdecimal()
            or int(node.serial) <= 0
        ):
            raise ValueError("Echo cancellation requires pinned source/sink serials")
    passive = {
        "audio.position": ["FL", "FR"],
        "node.passive": True,
        "node.always-process": False,
        "node.pause-on-idle": True,
        "node.dont-fallback": True,
        "node.dont-reconnect": True,
        "node.dont-move": True,
        "stream.dont-remix": True,
    }
    args = {
        "library.name": "aec/libspa-aec-webrtc",
        "monitor.mode": True,
        "audio.rate": 48000,
        "audio.channels": 2,
        "audio.position": ["FL", "FR"],
        "aec.args": {"webrtc.gain_control": False},
        "capture.props": {
            **passive,
            "node.name": "paj_voice_aec_capture",
            "target.object": source.serial,
        },
        "source.props": {
            "node.name": name,
            "node.description": "Paj temporary echo-cancelled microphone",
            "media.class": "Audio/Source",
            "audio.position": ["FL", "FR"],
            "priority.session": 0,
            "node.always-process": False,
            "node.pause-on-idle": True,
            "state.restore-props": False,
        },
        "sink.props": {
            **passive,
            "node.name": "paj_voice_aec_reference",
            "media.class": "Stream/Input/Audio",
            "target.object": sink.serial,
            "stream.monitor": True,
            "stream.capture.sink": True,
        },
    }
    payload = json.dumps(args, separators=(",", ":"))
    # pw-cli truncates its entire reconstructed command at '#', even inside a quoted argument.
    if "#" in payload:
        raise ValueError("Unsafe pw-cli echo arguments")
    return payload
