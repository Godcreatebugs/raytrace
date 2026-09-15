"""External gVisor SecCheck v1 collector. Python stdlib only; never mount into guests.

Wire/schema references: google/gvisor pkg/sentry/seccheck/{points,sinks/remote}.
Only selected fields are decoded; unknown event payloads are retained as base64.
The bounded protobuf reader handles wire types, not arbitrary recursive schemas.
"""
import argparse
import base64
import json
import os
import socket
import sqlite3
import struct
import threading
import time
import uuid

MAX_PACKET = 1024 * 1024


def fields(data):
    result = {}
    pos = 0

    def varint():
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            if pos >= len(data):
                raise ValueError('truncated varint')
            byte = data[pos]
            pos += 1
            if shift == 63 and byte > 1:
                raise ValueError('varint overflow')
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError('invalid varint')

    while pos < len(data):
        tag = varint()
        number, wire = tag >> 3, tag & 7
        if not number:
            raise ValueError('invalid field zero')
        if wire == 0:
            value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else (8 if wire == 1 else 4)
            if pos + size > len(data):
                raise ValueError('truncated field')
            value = data[pos:pos + size]
            pos += size
        else:
            raise ValueError('unsupported wire type')
        result.setdefault(number, []).append(value)
    return result


def one(data, key, default=0):
    return data.get(key, [default])[-1]


def string(value):
    if not isinstance(value, bytes):
        raise ValueError('expected string field')
    return value.decode('utf-8', errors='replace')


def signed(value):
    return value - (1 << 64) if value >= (1 << 63) else value


def decode(packet):
    if len(packet) < 8 or len(packet) > MAX_PACKET:
        raise ValueError('invalid packet size')
    size, kind, dropped = struct.unpack_from('<HHI', packet)
    if size < 8 or size > len(packet):
        raise ValueError('invalid header size')
    data = fields(packet[size:])
    context = fields(one(data, 1, b''))
    event = {
        'source': 'gvisor_seccheck', 'message_type': kind,
        'dropped_count': dropped, 'timestamp_ns': str(one(context, 1)),
        'container_id': string(one(context, 6, b'')),
        'pid': one(context, 4), 'tid': one(context, 2),
        'process_start_ns': str(one(context, 5)),
        'ppid': one(context, 10), 'cwd': string(one(context, 8, b'')),
        'process_name': string(one(context, 9, b'')),
        'kind': 'runtime_event',
    }
    if kind == 3:
        event.update(kind='exec_succeeded', executable=string(one(data, 2, b'')),
                     argv=[string(v) for v in data.get(3, [])])
    elif kind == 11:
        event.update(kind='exec_attempt', executable=string(one(data, 6, b'')),
                     argv=[string(v) for v in data.get(7, [])])
        if 2 in data:
            status = fields(one(data, 2))
            errno = one(status, 2)
            event.update(kind='exec_failed' if errno else 'exec_syscall_return',
                         errno=errno, result=signed(one(status, 1)))
    elif kind == 2:
        event.update(kind='clone', child_pid=one(data, 4), child_tid=one(data, 3),
                     child_start_ns=str(one(data, 5)))
    elif kind in (4, 5):
        status = one(data, 2)
        event.update(kind='process_exit' if kind == 4 else 'thread_exit',
                     wait_status=status,
                     exit_code=(status >> 8) & 255 if status & 127 == 0 else None,
                     signal=status & 127 if status & 127 else None)
    elif kind == 6:
        status = fields(one(data, 2, b''))
        event.update(kind='syscall_return' if 2 in data else 'syscall_enter',
                     sysno=one(data, 4), result=signed(one(status, 1)), errno=one(status, 2))
    else:
        event['payload_base64'] = base64.b64encode(packet[size:]).decode('ascii')
    # Preserve original evidence for decoder corrections and schema upgrades.
    # This may contain sensitive argv; the DB must stay outside the workload.
    event['raw_packet_base64'] = base64.b64encode(packet).decode('ascii')
    return event


def init_db(path):
    db = sqlite3.connect(path, timeout=10)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('''CREATE TABLE IF NOT EXISTS runtime_events (
      id INTEGER PRIMARY KEY, connection TEXT NOT NULL, received_ms INTEGER NOT NULL,
      container_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL)''')
    db.execute('CREATE INDEX IF NOT EXISTS runtime_container ON runtime_events(container_id,id)')
    db.commit()
    return db


def serve(endpoint, database):
    os.umask(0o077)
    init_db(database).close()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    # Refuse to replace an existing socket: a second collector must not steal it.
    server.bind(endpoint)
    server.listen(32)
    slots = threading.BoundedSemaphore(64)

    def client(conn):
        db = init_db(database)
        connection = str(uuid.uuid4())
        def record(event):
            db.execute('INSERT INTO runtime_events(connection,received_ms,container_id,kind,body) VALUES(?,?,?,?,?)',
                       (connection, int(time.time() * 1000), event.get('container_id', ''),
                        event['kind'], json.dumps(event)))
            db.commit()
        try:
            conn.settimeout(5)
            greeting, _, flags, _ = conn.recvmsg(4096)
            if flags & socket.MSG_TRUNC or one(fields(greeting), 1) != 1:
                raise ValueError('unsupported handshake')
            conn.sendall(b'\x08\x01')
            conn.settimeout(None)
            record({'kind': 'collector_connected', 'source': 'collector'})
            previous_dropped = 0
            while True:
                packet, _, flags, _ = conn.recvmsg(MAX_PACKET)
                if not packet:
                    break
                if flags & socket.MSG_TRUNC:
                    raise ValueError('oversized event')
                event = decode(packet)
                if event['dropped_count'] != previous_dropped:
                    record({'kind': 'collection_gap', 'container_id': event['container_id'],
                            'dropped_delta': (event['dropped_count'] - previous_dropped) % (1 << 32)})
                    previous_dropped = event['dropped_count']
                record(event)
        except Exception as error:
            record({'kind': 'collection_error', 'error': str(error)[:500]})
        finally:
            # EOF alone does not prove a complete trace; final dropped events
            # may never have been reported in a subsequent packet.
            record({'kind': 'collector_disconnected', 'coverage': 'not_certified'})
            conn.close()
            db.close()
            slots.release()
    print('RayTrace collector ready: ' + endpoint, flush=True)
    try:
        while True:
            conn, _ = server.accept()
            if not slots.acquire(blocking=False):
                conn.close()
                continue
            threading.Thread(target=client, args=(conn,), daemon=True).start()
    finally:
        server.close()
        os.unlink(endpoint)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--database', required=True)
    opts = parser.parse_args()
    serve(opts.socket, opts.database)
