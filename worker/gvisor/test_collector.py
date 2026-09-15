import struct
import unittest
from collector import decode, fields


def vint(n):
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    return bytes(out) + bytes([n])


def field(n, v):
    if isinstance(v, str):
        v = v.encode()
    return vint(n * 8 + 2) + vint(len(v)) + v if isinstance(v, bytes) else vint(n * 8) + vint(v)


def packet(kind, data, dropped=0):
    return struct.pack('<HHI', 8, kind, dropped) + data


class CollectorTests(unittest.TestCase):
    def test_success_has_actual_argv_and_identity(self):
        context = field(4, 12) + field(5, 1234567890123456789) + field(6, 'sandbox') + field(10, 1)
        event = decode(packet(3, field(1, context) + field(2, '/bin/ls') + field(3, 'ls') + field(3, '-la')))
        self.assertEqual(event['kind'], 'exec_succeeded')
        self.assertEqual(event['argv'], ['ls', '-la'])
        self.assertEqual(event['process_start_ns'], '1234567890123456789')
        self.assertEqual(event['container_id'], 'sandbox')

    def test_failed_exec_is_never_success(self):
        event = decode(packet(11, field(6, '/missing') + field(2, field(1, (1 << 64)-1) + field(2, 2))))
        self.assertEqual(event['kind'], 'exec_failed')
        self.assertEqual(event['errno'], 2)
        self.assertEqual(event['result'], -1)

    def test_attempt_and_exit(self):
        self.assertEqual(decode(packet(11, field(6, '/bin/ls')))['kind'], 'exec_attempt')
        self.assertEqual(decode(packet(4, field(2, 7 << 8)))['exit_code'], 7)
        self.assertEqual(decode(packet(4, field(2, 9)))['signal'], 9)

    def test_malformed_frames_are_rejected(self):
        for data in [b'', struct.pack('<HHI', 100, 3, 0), packet(3, b'\x12\xff'), packet(3, b'\x00')]:
            with self.assertRaises(ValueError):
                decode(data)

    def test_unknown_events_and_dropped_counter_are_preserved(self):
        event = decode(packet(999, field(7, 123), 9))
        self.assertEqual(event['dropped_count'], 9)
        self.assertIn('payload_base64', event)


if __name__ == '__main__':
    unittest.main()
