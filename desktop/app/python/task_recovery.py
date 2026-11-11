"""Durable, bounded ownership of a single primary conversation request."""
import ctypes
import fcntl
import json
import os
import uuid
from pathlib import Path
from resumable_thread import _state_library, atomic_write, state_dir


def acquire_owner():
    path = state_dir() / 'task-recovery-owner.lock'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = open(path, 'a+')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def _change(fn):
    path = state_dir() / 'task-recovery.json'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(str(path) + '.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            current = json.loads(path.read_text())
            if not isinstance(current, dict) or current.get('version') != 1:
                raise ValueError('invalid recovery state')
        except FileNotFoundError:
            current = None
        # Older records contained the full request. It is unnecessary: the saved
        # Codex conversation already holds it. Scrub before any admission.
        if current is not None and 'task' in current:
            current.pop('task')
            atomic_write(path, json.dumps(current) + '\n')
        result, replacement = fn(current)
        if replacement is not None:
            atomic_write(path, json.dumps(replacement) + '\n')
        return result



def _native(request):
    library = _state_library()
    if library is None:
        return False, None
    directory = os.fsencode(state_dir())
    value = json.dumps(request, ensure_ascii=True).encode('utf-8')
    output = ctypes.create_string_buffer(1024 * 1024)
    size = library.agent_recovery_apply(directory, len(directory), value, len(value), output, len(output))
    if size < 0:
        raise OSError(-size, os.strerror(-size))
    result = json.loads(output.raw[:size])
    if not result.get('ok'):
        message = result.get('error', 'Invalid recovery state')
        if message == 'State unavailable':
            raise OSError(message)
        raise ValueError(message)
    return True, result.get('result')

def begin(task, device, thread, receipt_id=None):
    identity = uuid.uuid4().hex
    native, result = _native({'op':'begin','id':identity,'device':device,'thread':thread,
                              'receiptId':receipt_id})
    if native:
        return result
    record = {'version': 1, 'id': identity, 'device': device,
              'thread': thread, 'status': 'active', 'startup_attempts': 0, 'blocked_attempts': 0}
    if receipt_id:
        record['receiptId'] = receipt_id
    return _change(lambda _: (record['id'], record))


def current():
    native, result = _native({'op':'current'})
    if native:
        return result
    return _change(lambda record: (dict(record) if record else None, None))


def finish(identity, status):
    native, result = _native({'op':'finish','identity':identity,'status':status})
    if native:
        return result
    def change(record):
        if not record or record.get('id') != identity:
            return False, None
        record['status'] = status
        return True, record
    return _change(change)


def reserve(kind, identity=None):
    field = kind + '_attempts'
    if kind not in ('startup', 'blocked'):
        raise ValueError('invalid recovery kind')
    native, result = _native({'op':'reserve','kind':kind,'identity':identity})
    if native:
        return result
    def change(record):
        if (not record or record.get('status') != 'active' or
                (identity is not None and record.get('id') != identity) or
                record.get(field, 0) >= 1):
            return None, None
        if not all(isinstance(record.get(k), str) and record[k] for k in ('id', 'thread')):
            raise ValueError('invalid recovery record')
        if record.get('device') not in ('mac', 'phone'):
            raise ValueError('invalid recovery device')
        record[field] = record.get(field, 0) + 1
        return dict(record), record
    return _change(change)
