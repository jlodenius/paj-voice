import threading
import unittest

from paj_voice_audio import open_mic
from paj_voice_audio.audio import Speaker as ActualSpeaker
import test_open_mic


class FocusProtocolTests(unittest.TestCase):
    fixture = test_open_mic.OpenMicTests.fixture

    def playback_fixture(self):
        gate = threading.Event()
        gate.set()
        writing = threading.Event()

        def prepare(config, graph, models):
            original = open_mic.Speaker

            class Speaker(ActualSpeaker):
                def play(self, pcm, ident=None, *, rate=None):
                    original.play(self, pcm, ident)
                    super().play(pcm, ident)

            class Sink:
                rate = 16000

                def __init__(self, *args):
                    pass

                def write(self, pcm, current, *, rate):
                    writing.set()
                    while not gate.wait(0.005):
                        if not current():
                            return False
                    return current()

                def drain(self, current):
                    pass

                def abort(self):
                    pass

                def close(self):
                    gate.set()

                def health(self):
                    pass

            open_mic.Speaker = Speaker
            open_mic.PipeSink = Sink

        runtime, events, *_ = self.fixture(prepare=prepare)
        self.addCleanup(gate.set)
        test_open_mic.wait_for(lambda: any(e['type'] == 'playback_state' and not e['playing']
                                          and e['id'] == 'ready' for e in events))
        writing.clear()
        gate.clear()
        return runtime, events, gate, writing

    def test_protocol_tracks_actual_headset_readout_and_drain_not_synthesis(self):
        runtime, events, gate, writing = self.playback_fixture()
        self.assertTrue(any(e['type'] == 'ready' and e['speakerMode'] is False for e in events))
        runtime.command({'type': 'speak', 'id': 'answer', 'text': 'A synthetic reply.'})
        self.assertTrue(writing.wait(1))
        test_open_mic.wait_for(lambda: any(e['type'] == 'playback_state' and e['id'] == 'answer'
                                          for e in events))
        states = [e for e in events if e['type'] == 'playback_state' and e['id'] == 'answer']
        self.assertEqual([e['playing'] for e in states], [True])
        self.assertEqual(set(states[0]), {'type', 'id', 'playing', 'playbackGeneration', 'outputEpoch'})
        gate.set()
        test_open_mic.wait_for(lambda: any(e['type'] == 'playback_state' and e['id'] == 'answer'
                                          and not e['playing'] for e in events))
        states = [e for e in events if e['type'] == 'playback_state' and e['id'] == 'answer']
        self.assertEqual([e['playing'] for e in states], [True, False])
        self.assertEqual(states[0]['playbackGeneration'], states[1]['playbackGeneration'])
        self.assertEqual(states[0]['outputEpoch'], states[1]['outputEpoch'])
