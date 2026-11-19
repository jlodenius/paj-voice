import contextlib
import io
import json
import os
import queue
import subprocess
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from paj_voice_audio.cli import main
from paj_voice_audio.devices import (
    Child,
    ChildStartError,
    Graph,
    Node,
    PipeCapture,
    PipeSink,
    child_exec,
    command_paths,
    select_node,
)

SOURCE = Node("paj_voice_source", "31", "Audio/Source")
SINK = Node("paj_voice_sink", "32", "Audio/Sink")
PATHS = {name: "/bin/" + name for name in ("pw-record", "pw-play", "pw-dump")}


def entry(node):
    return {
        "type": "PipeWire:Interface:Node",
        "info": {
            "state": "running",
            "props": {
                "node.name": node.name,
                "object.serial": node.serial,
                "media.class": node.kind,
            },
        },
    }


class Vad:
    def chunk_bytes(self):
        return 1024

    def __call__(self, frame):
        if len(frame) != self.chunk_bytes():
            raise ValueError("Wrong VAD frame size")
        return 0


class GraphTests(unittest.TestCase):
    def graph(self, entries=None):
        run = Mock(
            return_value=SimpleNamespace(
                stdout=json.dumps(entries or [entry(SOURCE), entry(SINK)])
            )
        )
        return Graph(paths=PATHS, run=run)

    def test_output_hint_uses_only_explicit_node_form_factor_and_never_bluetooth(self):
        for form, expected in [('speaker', 'speakers'), ('headphone', 'headphones'),
                               ('headset', 'headphones'), ('internal', 'unknown'),
                               ('Speaker', 'unknown'), (['speaker', 'headphone'], 'unknown'),
                               (None, 'unknown')]:
            for bluetooth in (False, True):
                with self.subTest(form=form, bluetooth=bluetooth):
                    source, sink = entry(SOURCE), entry(SINK)
                    props = sink['info']['props']
                    props.update({'device.id': 7, 'node.description': 'Headphone Speakers',
                                  'device.form-factor': form})
                    card = {'id': 7, 'type': 'PipeWire:Interface:Device', 'info': {'props': {
                        'device.name': 'synthetic.card', 'device.api': 'bluez5' if bluetooth else 'alsa',
                        'device.form-factor': 'speaker'}}}
                    devices = self.graph([card, source, sink]).devices()
                    self.assertNotIn('outputHint', devices[0])
                    self.assertEqual(devices[1].get('outputHint'),
                                     'unknown' if bluetooth else expected)

    def test_output_hint_never_guesses_from_names_cards_ports_or_bluetooth_profiles(self):
        for props in ({'node.description': 'Built-in Speakers'},
                      {'device.form-factor': 'speaker', 'device.api': 'bluez5'},
                      {'device.form-factor': 'speaker', 'device.bus': 'bluetooth'},
                      {'device.form-factor': 'headphone', 'api.bluez5.profile': 'a2dp-sink'},
                      {'device.form-factor': 'headset', 'bluez5.codec': 'sbc'},
                      {'port.name': 'analog-output-speaker'}):
            with self.subTest(props=props):
                sink = entry(SINK)
                sink['info']['props'].update(props)
                self.assertEqual(self.graph([sink]).devices()[0]['outputHint'], 'unknown')
        sink = entry(SINK)
        sink['info']['props'].update({'device.id': 7, 'device.form-factor': 'speaker'})
        card = {'id': 7, 'type': 'PipeWire:Interface:Device', 'info': {'props': {
            'device.name': 'synthetic.card', 'device.api': 'alsa'}}}
        self.assertEqual(self.graph([sink, card, card]).devices()[0]['outputHint'], 'unknown')

    def test_output_hint_requires_a_verified_non_bluetooth_device_association(self):
        sink = entry(SINK)
        sink['info']['props'].update({'device.id': 7, 'device.form-factor': 'headphone'})
        self.assertEqual(self.graph([sink]).devices()[0]['outputHint'], 'unknown')
        for api in (None, '', 'unclassified', 'bluez5'):
            with self.subTest(api=api):
                card = {'id': 7, 'type': 'PipeWire:Interface:Device', 'info': {'props': {
                    'device.name': 'synthetic.card', 'device.api': api}}}
                self.assertEqual(self.graph([sink, card]).devices()[0]['outputHint'], 'unknown')

    def test_configured_fallback_pair_rejects_absence_and_wrong_physical_identity(self):
        card = {'id': 7, 'type': 'PipeWire:Interface:Device',
                'info': {'props': {'device.name': 'alsa.builtin', 'device.api': 'alsa'}}}
        source, sink = entry(SOURCE), entry(SINK)
        for node in (source, sink):
            node['info']['props']['device.id'] = 7
        graph = self.graph([card, source, sink])
        frozen = graph.bind(SOURCE.name, SINK.name, 'alsa.builtin', 'alsa.builtin')
        for entries in ([card, source], [card, sink], [source, sink]):
            graph.run.return_value.stdout = json.dumps(entries)
            with self.assertRaises(RuntimeError):
                graph.bind(SOURCE.name, SINK.name, 'alsa.builtin', 'alsa.builtin')
            self.assertEqual(graph.bound, frozen)
        graph.run.return_value.stdout = json.dumps([card, source, sink])
        with self.assertRaisesRegex(RuntimeError, 'different physical'):
            graph.bind(SOURCE.name, SINK.name, 'alsa.other', 'alsa.builtin')
        graph.run.return_value.stdout = json.dumps([card, source])
        self.assertEqual(graph.available(SOURCE.name, SINK.name, 'alsa.builtin', 'alsa.builtin'),
                         (frozen[0], None))
        unresolved = Node(SINK.name, '', SINK.kind, 'alsa.builtin')
        self.assertEqual(graph.recover((unresolved,)), (None,))
        graph.run.return_value.stdout = json.dumps([card, source, sink])
        self.assertEqual(graph.recover((unresolved,)), (frozen[1],))

    def test_exact_name_class_serial_and_monitor_rejection(self):
        entries = [entry(SOURCE), entry(SINK)]
        self.assertEqual(select_node(entries, SOURCE.name, SOURCE.kind), SOURCE)
        for name in ("default", "auto", "0", "@DEFAULT_AUDIO_SOURCE@", "paj_monitor"):
            with self.assertRaises(ValueError):
                select_node(entries, name, SOURCE.kind)
        with self.assertRaisesRegex(RuntimeError, "exactly once"):
            select_node(entries * 2, SOURCE.name, SOURCE.kind)
        with self.assertRaisesRegex(RuntimeError, "media.class"):
            select_node(entries, SINK.name, SOURCE.kind)
        entries[0]["info"]["props"]["object.serial"] = ""
        with self.assertRaisesRegex(RuntimeError, "serial"):
            select_node(entries, SOURCE.name, SOURCE.kind)

    def test_recovery_resolves_endpoints_independently_and_requires_frozen_identity(self):
        graph = self.graph()
        frozen = graph.bind(SOURCE.name, SINK.name)
        graph.run.return_value.stdout = json.dumps([entry(SOURCE)])
        self.assertEqual(graph.recover(frozen), (SOURCE, None))
        replacement = entry(SOURCE)
        replacement['info']['props']['object.serial'] = '99'
        graph.run.return_value.stdout = json.dumps([replacement, entry(SINK)])
        self.assertEqual(graph.recover(frozen), (None, SINK))
        card = {'id': 7, 'type': 'PipeWire:Interface:Device',
                'info': {'props': {'device.name': 'usb.chosen', 'device.api': 'alsa'}}}
        replacement['info']['props']['device.id'] = 7
        original = entry(SOURCE)
        original['info']['props']['device.id'] = 7
        graph.run.return_value.stdout = json.dumps([card, original, entry(SINK)])
        frozen = graph.bind(SOURCE.name, SINK.name)
        graph.run.return_value.stdout = json.dumps([card, replacement, entry(SINK)])
        self.assertEqual(graph.recover(frozen)[0].serial, '99')
        card['info']['props']['device.name'] = 'usb.other'
        graph.run.return_value.stdout = json.dumps([card, replacement, entry(SINK)])
        self.assertIsNone(graph.recover(frozen)[0])
        graph.run.side_effect = subprocess.TimeoutExpired('pw-dump', 3)
        with self.assertRaises(RuntimeError):
            graph.recover(frozen)

    def test_recovery_bluetooth_alias_is_unique_same_card_and_backend_only(self):
        card = {'id': 7, 'type': 'PipeWire:Interface:Device',
                'info': {'props': {'device.name': 'bluez.chosen', 'device.api': 'bluez5'}}}
        source = entry(SOURCE)
        source['info']['props']['device.id'] = 7
        graph = self.graph([card, source, entry(SINK)])
        frozen = graph.bind(SOURCE.name, SINK.name)
        alias = entry(Node('new.alias', '99', SOURCE.kind))
        alias['info']['props']['device.id'] = 7
        graph.run.return_value.stdout = json.dumps([card, alias, entry(SINK)])
        actual, output = graph.recover(frozen)
        self.assertEqual((actual.name, actual.serial, actual.device), ('new.alias', '99', 'bluez.chosen'))
        self.assertEqual(output, SINK)
        graph.run.return_value.stdout = json.dumps([card, source, alias, entry(SINK)])
        self.assertIsNone(graph.recover(frozen)[0])
        card['info']['props']['device.api'] = 'alsa'
        graph.run.return_value.stdout = json.dumps([card, alias, entry(SINK)])
        self.assertIsNone(graph.recover(frozen)[0])
        card['info']['props'].update({'device.api': 'bluez5', 'device.name': 'bluez.other'})
        graph.run.return_value.stdout = json.dumps([card, alias, entry(SINK)])
        self.assertIsNone(graph.recover(frozen)[0])

    def test_bound_target_loss_and_same_name_replacement_fail(self):
        graph = self.graph()
        self.assertEqual(graph.bind(SOURCE.name, SINK.name), (SOURCE, SINK))
        graph.check()
        graph.run.return_value.stdout = json.dumps([entry(SINK)])
        with self.assertRaisesRegex(RuntimeError, "exactly once"):
            graph.check()
        replacement = entry(SOURCE)
        replacement["info"]["props"]["object.serial"] = "99"
        graph.run.return_value.stdout = json.dumps([replacement, entry(SINK)])
        with self.assertRaisesRegex(RuntimeError, "replaced"):
            graph.check()

    def test_devices_only_uses_pw_dump_and_never_opens_audio(self):
        graph = self.graph()
        output = io.StringIO()
        with (
            patch("paj_voice_audio.devices.Graph", return_value=graph),
            patch.object(sys, "argv", ["paj-voice-audio", "--devices"]),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(main(), 0)
        devices = json.loads(output.getvalue())
        self.assertEqual([item["name"] for item in devices], [SOURCE.name, SINK.name])
        graph.run.assert_called_once_with(
            [PATHS["pw-dump"], "--no-colors"],
            capture_output=True,
            check=True,
            timeout=3,
        )

    def test_missing_commands_and_graph_error_are_actionable(self):
        with patch("paj_voice_audio.devices.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Install PipeWire.*pw-record"):
                command_paths()
        graph = self.graph()
        graph.run.side_effect = subprocess.TimeoutExpired("pw-dump", 3)
        with self.assertRaisesRegex(RuntimeError, "pw-dump"):
            graph.snapshot()
        bad = entry(SOURCE)
        bad["info"]["state"] = "error"
        with self.assertRaisesRegex(RuntimeError, "error state"):
            select_node([bad], SOURCE.name, SOURCE.kind)


class ChildTests(unittest.TestCase):
    def process(self, diagnostic=b""):
        process = Mock()
        process.stdin = Mock()
        process.stdin.fileno.return_value = 123
        process.stdout = None
        process.stderr = io.BytesIO(diagnostic)
        process.poll.return_value = None
        def wait(timeout):
            process.poll.return_value = 0
            return 0
        process.wait.side_effect = wait
        return process

    def spawn(self, process, capture=False):
        with (
            patch(
                "paj_voice_audio.devices.subprocess.Popen", return_value=process
            ) as popen,
            patch("paj_voice_audio.devices.os.set_blocking"),
            patch("paj_voice_audio.devices.fcntl.fcntl", return_value=8192),
        ):
            child = Child(
                PATHS["pw-record"] if capture else PATHS["pw-play"],
                SOURCE if capture else SINK,
                16000,
                capture,
            )
        child.stderr_thread.join(timeout=1)
        return child, popen

    def test_partial_child_constructor_failure_reaps_process_without_joining_unstarted_thread(self):
        process = self.process()
        thread = SimpleNamespace(start=Mock(side_effect=RuntimeError('Synthetic thread creation failure')),
                                 join=Mock(side_effect=RuntimeError('Cannot join unstarted thread')))
        with patch('paj_voice_audio.devices.subprocess.Popen', return_value=process), \
                patch('paj_voice_audio.devices.threading.Thread', return_value=thread):
            with self.assertRaises(RuntimeError) as raised:
                Child('/synthetic/recorder', SOURCE, 16000, True)
        self.assertTrue(process.terminate.called or process.kill.called)
        self.assertIsNotNone(process.poll())
        thread.join.assert_not_called()
        self.assertIs(raised.exception.child.process, process)
        self.assertTrue(raised.exception.child.stop_complete)

    def test_voice_identity_is_registered_before_capture_or_playback_starts(self):
        for capture in (False, True):
            with self.subTest(capture=capture):
                child, popen = self.spawn(self.process(), capture=capture)
                args = popen.call_args.args[0]
                properties = json.loads(args[args.index('--properties') + 1])
                self.assertEqual(properties['application.id'], 'org.paj.voice')
                self.assertEqual(properties['paj.voice.owner'], str(os.getpid()))
                self.assertEqual(properties['node.name'],
                                 'paj_voice_record' if capture else 'paj_voice_play')
                child.stop()

    def test_serial_pinned_raw_args_and_no_fallback(self):
        process = self.process()
        child, popen = self.spawn(process)
        args = popen.call_args.args[0]
        self.assertEqual(args[:3], [sys.executable, "-P", "-m"])
        native = args[args.index(PATHS["pw-play"]) :]
        self.assertEqual(native[native.index("--target") + 1], SINK.serial)
        self.assertEqual(native[native.index("--rate") + 1], "16000")
        self.assertEqual(native[native.index("--format") + 1], "s16")
        self.assertIn("--raw", native)
        properties = json.loads(native[native.index("--properties") + 1])
        self.assertIs(properties["node.dont-fallback"], True)
        self.assertIs(properties["node.dont-reconnect"], True)
        self.assertIn("--child", args)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        child.stop()
        process.terminate.assert_called_once()
        process.wait.assert_called()

    def test_kill_escalation_reaps_and_discontinuity_fails(self):
        process = self.process(b"audio XRUN detected")
        process.wait.side_effect = [subprocess.TimeoutExpired("pw-play", 0.3), -9]
        process.kill.side_effect = lambda: setattr(process.poll, 'return_value', -9)
        child, _ = self.spawn(process)
        with self.assertRaisesRegex(RuntimeError, "discontinuity"):
            child.health()
        child.stop()
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)
        child.stop()
        process.kill.assert_called_once()

    def test_stop_retries_a_live_child_after_timeout_and_kill_error(self):
        process = self.process()
        child, _ = self.spawn(process, capture=True)
        process.wait.side_effect = subprocess.TimeoutExpired('fake-recorder', 0.3)
        process.kill.side_effect = OSError('Fake kill failure')
        with self.assertRaises(OSError):
            child.stop()
        self.assertIsNone(process.poll())
        process.kill.side_effect = None
        def wait(timeout):
            process.poll.return_value = -9
            return -9
        process.wait.side_effect = wait
        child.stop()
        self.assertEqual(process.terminate.call_count, 2)
        self.assertIsNotNone(process.poll())
        self.assertTrue(child.stop_complete)
        child.stop()
        self.assertEqual(process.terminate.call_count, 2)

    def test_stop_rejects_unconfirmed_exit_even_if_wait_returns(self):
        process = self.process()
        child, _ = self.spawn(process, capture=True)
        process.wait.side_effect = None
        process.wait.return_value = 0
        with self.assertRaisesRegex(RuntimeError, 'exit.*unconfirmed'):
            child.stop()
        process.poll.return_value = 0
        child.stop()
        self.assertTrue(child.stop_complete)

    def test_parent_death_guard_checks_before_and_after_prctl(self):
        libc = Mock()
        libc.prctl.return_value = 0
        with (
            patch("paj_voice_audio.devices.ctypes.CDLL", return_value=libc),
            patch("paj_voice_audio.devices.os.getppid", side_effect=[10, 11]),
            patch("paj_voice_audio.devices.os.execv") as execute,
        ):
            self.assertEqual(child_exec(10, ["/bin/true"]), 1)
            libc.prctl.assert_called_once()
            execute.assert_not_called()
        with (
            patch("paj_voice_audio.devices.os.getppid", return_value=11),
            patch("paj_voice_audio.devices.os.execv") as execute,
        ):
            self.assertEqual(child_exec(10, ["/bin/true"]), 1)
            execute.assert_not_called()


class SinkTests(unittest.TestCase):
    def sink(self):
        child = Mock()
        child.process.stdin.fileno.return_value = 123
        child.process.poll.return_value = None
        launch = Mock(return_value=child)
        sink = PipeSink(PATHS["pw-play"], SINK, 22050, launch=launch)
        self.addCleanup(sink.close)
        return sink, child, launch

    def test_lazy_playback_and_normal_drain(self):
        sink, child, launch = self.sink()
        launch.assert_not_called()
        with patch("paj_voice_audio.devices.os.write", side_effect=lambda fd, data: len(data)):
            self.assertTrue(sink.write(b"\0" * 4, lambda: True))
        launch.assert_called_once_with(PATHS["pw-play"], SINK, 22050, False)
        child.process.poll.side_effect = [None, 0]
        with patch("paj_voice_audio.devices.time.sleep"):
            sink.drain(lambda: True)
        child.process.stdin.close.assert_called_once()
        child.stop.assert_called_once()
        self.assertIsNone(sink.child)

    def test_sink_retains_partial_child_startup_failure_until_abort_cleanup_succeeds(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = OSError('Synthetic wait failure')
        process.kill.side_effect = OSError('Synthetic kill failure')
        thread = SimpleNamespace(start=Mock(side_effect=RuntimeError('Synthetic stderr start failure')),
                                 join=Mock(side_effect=RuntimeError('Unstarted thread')))
        sink = PipeSink('/synthetic/player', SINK, 22050, launch=Child)
        with patch('paj_voice_audio.devices.subprocess.Popen', return_value=process), \
                patch('paj_voice_audio.devices.threading.Thread', return_value=thread):
            with self.assertRaises(RuntimeError):
                sink.write(b'\0\0', lambda: True)
        self.assertIs(sink.child.process, process)
        with self.assertRaises(OSError):
            sink.close()
        self.assertTrue(any(child.process is process for child in sink.retired_children))
        def reap(timeout):
            process.poll.return_value = -9
            return -9
        process.wait.side_effect = reap
        process.kill.side_effect = None
        sink.close()
        self.assertFalse(sink.retired_children)
        self.assertIsNotNone(process.poll())
        thread.join.assert_not_called()

    def test_failed_player_cleanup_blocks_new_launches_until_reaped(self):
        child = Mock()
        child.process.poll.return_value = None
        child.stop.side_effect = OSError('Synthetic teardown failure')
        launch = Mock(side_effect=ChildStartError(child, False))
        sink = PipeSink('/synthetic/player', SINK, 22050, launch=launch)
        def cleanup():
            child.stop.side_effect = None
            sink.close()
        self.addCleanup(cleanup)
        for _ in range(12):
            with self.assertRaises(RuntimeError):
                sink.write(b'\0\0', lambda: True)
            with self.assertRaises(OSError):
                sink.abort()
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(sink.retired_children, [child])
        with self.assertRaises(RuntimeError):
            sink.health()
        child.process.poll.return_value = -9
        child.stop.side_effect = None
        sink.abort()
        self.assertFalse(sink.retired_children)
        healthy = Mock()
        healthy.process.stdin.fileno.return_value = 123
        launch.side_effect = None
        launch.return_value = healthy
        with patch('paj_voice_audio.devices.os.write', side_effect=lambda fd, data: len(data)):
            self.assertTrue(sink.write(b'\0\0', lambda: True))
        self.assertEqual(launch.call_count, 2)

    def test_abort_before_launch_and_during_backpressure_discards_stale_pcm(self):
        sink, child, launch = self.sink()

        def stale():
            sink.abort()
            return True

        self.assertFalse(sink.write(b"\0" * 4, stale))
        launch.assert_not_called()
        running = [True]

        def cancel(*args):
            running[0] = False
            sink.abort()
            return [], [], []

        with (
            patch("paj_voice_audio.devices.os.write", side_effect=BlockingIOError),
            patch("paj_voice_audio.devices.select.select", side_effect=cancel),
        ):
            self.assertFalse(sink.write(b"\0" * 4, lambda: running[0]))
        child.stop.assert_called_once()
        self.assertIsNone(sink.child)

    def test_backpressure_and_unexpected_exit_fail_closed(self):
        sink, child, _ = self.sink()
        with (
            patch("paj_voice_audio.devices.os.write", side_effect=BlockingIOError),
            patch("paj_voice_audio.devices.time.monotonic", side_effect=[0, 3]),
        ):
            with self.assertRaisesRegex(RuntimeError, "backpressure"):
                sink.write(b"\0" * 4, lambda: True)
        child.health.side_effect = RuntimeError("child exited")
        with self.assertRaisesRegex(RuntimeError, "child exited"):
            sink.health()

class CaptureTests(unittest.TestCase):
    def capture(self):
        errors = []
        turns = Mock()
        child = Mock()
        child.process.stdout.fileno.return_value = 123
        launch = Mock(return_value=child)
        capture = PipeCapture(
            PATHS["pw-record"], SOURCE, Vad, 0.01, turns, errors.append, launch=launch
        )
        self.addCleanup(capture.close)
        return capture, child, launch, turns, errors

    def test_capture_retains_partial_constructor_child_when_initial_and_retried_cleanup_fail(self):
        process = Mock()
        process.poll.return_value = None
        process.stderr = io.BytesIO()
        process.wait.side_effect = subprocess.TimeoutExpired('synthetic-recorder', 0.3)
        process.kill.side_effect = OSError('Synthetic kill failure')
        thread = SimpleNamespace(start=Mock(side_effect=RuntimeError('Synthetic thread start failure')),
                                 join=Mock(side_effect=RuntimeError('Unstarted thread')))
        capture = PipeCapture('/synthetic/recorder', SOURCE, Vad, 0.01, Mock(), Mock(), launch=Child)
        with patch('paj_voice_audio.devices.subprocess.Popen', return_value=process), \
                patch('paj_voice_audio.devices.threading.Thread', return_value=thread):
            with self.assertRaises(RuntimeError):
                capture.start()
        self.assertIsNotNone(capture.child)
        self.assertIs(capture.child.process, process)
        self.assertIsNone(process.poll())
        with self.assertRaises(OSError):
            capture.close()
        self.assertFalse(capture.close_complete)
        process.kill.side_effect = None
        def wait(timeout):
            process.poll.return_value = -9
            return -9
        process.wait.side_effect = wait
        capture.close()
        self.assertIsNotNone(process.poll())
        self.assertTrue(capture.close_complete)
        self.assertGreaterEqual(process.terminate.call_count, 3)
        thread.join.assert_not_called()

    def test_capture_thread_start_failure_keeps_child_and_never_joins_unstarted_threads(self):
        capture, child, *_ = self.capture()
        child.process.poll.return_value = None
        child.stop.side_effect = lambda: setattr(child.process.poll, 'return_value', 0)
        thread = SimpleNamespace(start=Mock(side_effect=RuntimeError('Synthetic VAD thread failure')),
                                 join=Mock(side_effect=RuntimeError('Unstarted thread')))
        with patch('paj_voice_audio.devices.threading.Thread', return_value=thread):
            with self.assertRaisesRegex(RuntimeError, 'Synthetic VAD'):
                capture.start()
        self.assertIs(capture.child, child)
        capture.close()
        child.stop.assert_called_once()
        thread.join.assert_not_called()
        self.assertTrue(capture.close_complete)

    def test_capture_close_retries_child_stop_after_a_failed_first_close(self):
        capture, child, *_ = self.capture()
        capture.child = child
        child.stop.side_effect = [OSError('Fake stop failure'), None]
        child.process.poll.return_value = None
        with self.assertRaises(OSError):
            capture.close()
        self.assertTrue(capture.closed.is_set())
        child.process.poll.return_value = 0
        capture.close()
        self.assertEqual(child.stop.call_count, 2)
        capture.close()
        self.assertEqual(child.stop.call_count, 2)

    def test_capture_close_requires_child_exit_not_just_closed_flag(self):
        capture, child, *_ = self.capture()
        capture.child = child
        child.process.poll.return_value = None
        with self.assertRaisesRegex(RuntimeError, 'exit.*unconfirmed'):
            capture.close()
        child.process.poll.return_value = 0
        capture.close()
        self.assertEqual(child.stop.call_count, 2)

    def test_pcm_readiness_with_synthetic_pipe_and_close_reaps(self):
        capture, child, launch, turns, errors = self.capture()
        read_fd, write_fd = os.pipe()
        source = os.fdopen(read_fd, "rb", buffering=0)
        child.process.stdout = source

        def stop():
            os.close(write_fd)

        child.stop.side_effect = stop
        capture.start()
        self.assertFalse(capture.first_pcm.is_set())
        os.write(write_fd, b"\0\0" * 512)
        capture.wait_ready(timeout=1)
        self.assertEqual(turns.feed.call_args.args, (b"\0\0" * 512, False))
        launch.assert_called_once_with(PATHS["pw-record"], SOURCE, 16000, True)
        capture.close()
        source.close()
        child.stop.assert_called_once()
        self.assertFalse(any(thread.is_alive() for thread in capture.threads))
        self.assertEqual(errors, [])

    def test_eof_truncated_pcm_and_overflow_fail_without_turn_submission(self):
        capture, child, _, turns, _ = self.capture()
        capture.child = child
        with patch("paj_voice_audio.devices.os.read", side_effect=[b"\1", b""]):
            capture._read()
        with self.assertRaisesRegex(RuntimeError, "EOF/discontinuity"):
            capture.wait_ready(timeout=0.01)
        turns.feed.assert_not_called()
        capture.fault = None
        capture.frames = queue.Queue(maxsize=1)
        with patch("paj_voice_audio.devices.os.read", return_value=b"\0" * 2048):
            capture._read()
        with self.assertRaisesRegex(RuntimeError, "overflow"):
            capture.health()
        turns.feed.assert_not_called()

    def test_stale_frames_timeout_and_child_loss_fail(self):
        capture, child, _, turns, errors = self.capture()
        capture.child = child
        capture.frames.put((time.monotonic() - 3, b"\0\0" * 512))
        capture._process()
        self.assertIn("stale", str(errors[0]))
        turns.feed.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "no PCM"):
            capture.wait_ready(timeout=0.01)
        child.health.side_effect = RuntimeError("lost capture")
        with self.assertRaisesRegex(RuntimeError, "lost capture"):
            capture.health()

    def test_close_clears_pending_audio(self):
        capture, child, _, _, _ = self.capture()
        capture.child = child
        capture._enqueue(b"\0\0" * 512)
        capture.close()
        self.assertTrue(capture.frames.empty())
        child.stop.assert_called_once()


if __name__ == "__main__":
    unittest.main()
