import json
import unittest

from paj_voice_audio.devices import Node
from paj_voice_audio.echo import monitor_arguments


class EchoArgumentsTests(unittest.TestCase):
    def test_monitor_mode_preserves_stereo_and_pins_both_targets(self):
        source = Node("microphone", "100", "Audio/Source")
        sink = Node("headphones", "200", "Audio/Sink")
        payload = monitor_arguments(source, sink)
        args = json.loads(payload)
        self.assertNotIn("#", payload)
        self.assertNotIn("\n", payload)
        self.assertIs(args["monitor.mode"], True)
        self.assertEqual(args["audio.position"], ["FL", "FR"])
        self.assertEqual(args["audio.channels"], 2)
        self.assertNotIn("playback.props", args)
        self.assertEqual(args["source.props"]["media.class"], "Audio/Source")
        self.assertEqual(args["sink.props"]["media.class"], "Stream/Input/Audio")
        for key, serial in [("capture.props", "100"), ("sink.props", "200")]:
            self.assertEqual(args[key]["target.object"], serial)
            self.assertIs(args[key]["node.dont-fallback"], True)
            self.assertIs(args[key]["node.dont-reconnect"], True)
            self.assertIs(args[key]["node.passive"], True)
        self.assertIs(args["sink.props"]["stream.capture.sink"], True)

    def test_cli_comment_truncation_and_wrong_targets_are_rejected(self):
        source = Node("microphone", "100", "Audio/Source")
        sink = Node("headphones", "200", "Audio/Sink")
        for name in ["bad#name", "bad\nname", "", "bad name"]:
            with self.assertRaises(ValueError):
                monitor_arguments(source, sink, name)
        for bad in [
            Node("microphone", "100#ignored", "Audio/Source"),
            Node("microphone", "0", "Audio/Source"),
            Node("microphone", "100", "Audio/Sink"),
        ]:
            with self.assertRaises(ValueError):
                monitor_arguments(bad, sink)
