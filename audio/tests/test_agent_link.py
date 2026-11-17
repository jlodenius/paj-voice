import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from paj_voice_audio.agent_link import AgentLink


class AgentLinkTests(unittest.TestCase):
    def serve(self, directory, handler):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        path = str(Path(directory) / "test.sock")
        listener.bind(path)
        listener.listen(1)
        listener.settimeout(2)
        errors = []

        def run():
            try:
                peer, _ = listener.accept()
                with peer:
                    peer.settimeout(2)
                    with peer.makefile("rb") as stream:
                        handler(peer, stream)
            except Exception as error:
                errors.append(error)
            finally:
                listener.close()

        thread = threading.Thread(target=run)
        thread.start()
        self.addCleanup(thread.join, 3)
        self.addCleanup(listener.close)
        return path, thread, errors

    def test_handshake_acceptance_answer_and_disconnect_without_any_audio(self):
        frames, received = [], []
        answered, fault = threading.Event(), threading.Event()

        def handler(peer, stream):
            frames.append(json.loads(stream.readline()))
            peer.sendall(b'{"type":"hello","version":1,"sessionId":"chosen"}\n')
            for _ in range(3):
                frames.append(json.loads(stream.readline()))
            peer.sendall(b'{"type":"armed"}\n{"type":"accepted","sequence":1}\n'
                         b'{"type":"reply_status","stage":"context","reason":"associated","generation":1}\n'
                         b'{"type":"answer","generation":1,"text":"Sixty seconds."}\n')
            answered.wait(1)

        with tempfile.TemporaryDirectory() as directory:
            path, thread, errors = self.serve(directory, handler)
            link = AgentLink(path, "chosen")
            try:
                def receive(frame):
                    received.append(frame)
                    if frame["type"] == "agent_answer":
                        answered.set()
                link.start(receive, fault.set)
                link.arm(90)
                link.onset(1)
                link.submit(1, "How many seconds?")
                self.assertTrue(answered.wait(2))
                self.assertTrue(fault.wait(2))
                self.assertEqual([frame["type"] for frame in frames], ["hello", "arm", "onset", "utterance"])
                self.assertEqual(received[0], {"type": "agent_accepted", "sequence": 1})
                self.assertEqual(received[1], {"type": "agent_status", "stage": "context",
                                               "reason": "associated", "generation": 1})
                self.assertEqual(received[2]["text"], "Sixty seconds.")
            finally:
                link.close()
                thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertFalse(errors)

    def test_wrong_session_is_rejected_before_any_arm_or_utterance(self):
        def handler(peer, stream):
            stream.readline()
            peer.sendall(b'{"type":"hello","version":1,"sessionId":"wrong"}\n')

        with tempfile.TemporaryDirectory() as directory:
            path, thread, errors = self.serve(directory, handler)
            with self.assertRaisesRegex(RuntimeError, "exact session"):
                AgentLink(path, "chosen")
            thread.join(2)
            self.assertFalse(errors)

    def test_oversized_second_frame_in_same_packet_is_also_rejected(self):
        link = object.__new__(AgentLink)
        link.buffer = b'{"type":"armed"}\n' + b'x' * 8193 + b'\n'
        self.assertEqual(link.read(), {"type": "armed"})
        with self.assertRaisesRegex(RuntimeError, "bounded"):
            link.read()


if __name__ == "__main__":
    unittest.main()
