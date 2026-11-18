import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from paj_voice_audio.devices import Graph, resolve_node


def node(name, serial, kind, device):
    return {'type': 'PipeWire:Interface:Node', 'info': {'state': 'running', 'props': {
        'node.name': name, 'object.serial': str(serial), 'media.class': kind, 'device.id': device}}}


def card(ident, name):
    return {'type': 'PipeWire:Interface:Device', 'id': ident,
            'info': {'props': {'device.name': name,
                               'device.api': 'bluez5' if name.startswith('bluez_card.') else 'alsa'}}}


class RouteGraphTests(unittest.TestCase):
    def graph(self, entries):
        run = Mock(return_value=SimpleNamespace(stdout=json.dumps(entries)))
        return Graph(paths={'pw-dump': 'FAKE'}, run=run)

    def test_saved_physical_bluetooth_identity_binds_changed_profile_nodes_not_names(self):
        identity = 'bluez_card.chosen'
        entries = [card(10, identity), card(20, 'bluez_card.other'),
                   node('bluez_input.new-hfp', 101, 'Audio/Source', 10),
                   node('bluez_output.new-hfp', 102, 'Audio/Sink', 10),
                   node('bluez_input.old-a2dp', 201, 'Audio/Source', 20)]
        graph = self.graph(entries)
        source, sink = graph.bind('bluez_input.old-a2dp', 'bluez_output.old-a2dp', identity, identity)
        self.assertEqual(source.name, 'bluez_input.new-hfp')
        self.assertEqual(source.serial, '101')
        self.assertEqual(source.device, identity)
        self.assertEqual(sink.device, identity)
        self.assertEqual(graph.devices()[0]['device'], identity)
        self.assertTrue(graph.devices()[0]['bluetooth'])
        graph.check()
        self.assertFalse(graph.profile_transition(identity))
        entries[2]['info']['props']['object.serial'] = '999'
        graph.run.return_value.stdout = json.dumps(entries)
        with self.assertRaisesRegex(RuntimeError, 'replaced'):
            graph.check()
        self.assertTrue(graph.profile_transition(identity))
        graph.run.return_value.stdout = json.dumps(entries[1:])
        self.assertFalse(graph.profile_transition(identity))

    def test_absent_ambiguous_or_monitor_physical_selection_never_uses_other_nodes(self):
        identity = 'bluez_card.chosen'
        source = node('bluez_input.chosen', 101, 'Audio/Source', 10)
        base = [card(10, identity), card(20, 'bluez_card.other'),
                node('bluez_input.other', 201, 'Audio/Source', 20)]
        with self.assertRaisesRegex(RuntimeError, 'absent or ambiguous'):
            resolve_node(base, 'bluez_input.other', 'Audio/Source', identity)
        with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
            resolve_node(base + [source, node('duplicate', 102, 'Audio/Source', 10)],
                         'bluez_input.other', 'Audio/Source', identity)
        source['info']['props']['stream.capture.sink'] = True
        with self.assertRaisesRegex(ValueError, 'monitors'):
            resolve_node(base + [source], 'bluez_input.chosen', 'Audio/Source', identity)

    def test_multiple_non_bluetooth_endpoints_keep_exact_node_and_card(self):
        identity = 'alsa_card.usb.chosen'
        entries = [card(10, identity), card(20, 'alsa_card.other')]
        for kind, prefix in [('Audio/Source', 'input'), ('Audio/Sink', 'output')]:
            entries += [node(f'{prefix}.chosen', 101, kind, 10),
                        node(f'{prefix}.another', 102, kind, 10),
                        node(f'{prefix}.other-card', 201, kind, 20)]
            selected = resolve_node(entries, f'{prefix}.chosen', kind, identity)
            self.assertEqual(selected.name, f'{prefix}.chosen')
            self.assertFalse(selected.bluetooth)
            with self.assertRaisesRegex(RuntimeError, 'exactly once'):
                resolve_node(entries, f'{prefix}.missing', kind, identity)
            with self.assertRaisesRegex(RuntimeError, 'different physical'):
                resolve_node(entries, f'{prefix}.other-card', kind, identity)
        graph = self.graph(entries)
        graph.bind('input.chosen', 'output.chosen', identity, identity)
        graph.check()
        self.assertFalse(graph.profile_transition(identity))

    def test_graph_inspection_honors_remaining_transition_budget(self):
        graph = self.graph([])
        graph.clock = lambda: 10
        with self.assertRaisesRegex(TimeoutError, 'deadline'):
            graph.snapshot(deadline=10)
        graph.run.assert_not_called()
        graph.snapshot(deadline=10.25)
        self.assertEqual(graph.run.call_args.kwargs['timeout'], 0.25)

    def test_node_without_saved_identity_requires_exact_name_and_rejects_defaults(self):
        entries = [card(10, 'bluez_card.chosen'), node('bluez_input.chosen', 101, 'Audio/Source', 10)]
        self.assertEqual(resolve_node(entries, 'bluez_input.chosen', 'Audio/Source').serial, '101')
        for value in ['default', 'auto', '@DEFAULT_AUDIO_SOURCE@', '0', '-1', 'speaker.monitor']:
            for physical in (None, 'bluez_card.chosen'):
                with self.assertRaises(ValueError):
                    resolve_node(entries, value, 'Audio/Source', physical)
        with self.assertRaises(RuntimeError):
            resolve_node(entries, 'old-name', 'Audio/Source')
