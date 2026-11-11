"""Durable workspace creation policy; no display or daemon operations here."""
import argparse
import fcntl
import json
import os
from pathlib import Path
from contextlib import contextmanager
from resumable_thread import atomic_write, state_dir

FILE = 'workspace-creation-policy.json'

@contextmanager
def _locked(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(directory / (FILE + '.lock'), os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield directory / FILE


def _read(path):
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return 'unconfigured'
    except (OSError, ValueError, UnicodeError):
        return 'closed'
    if not isinstance(data, dict) or data.get('version') != 1:
        return 'closed'
    mode = data.get('mode')
    return mode if mode in ('closed', 'allow-once', 'existing-only') else 'closed'


def _write(path, mode):
    atomic_write(path, json.dumps({'version': 1, 'mode': mode}) + '\n')


def set_policy(directory, mode):
    if mode not in ('closed', 'allow-once'):
        raise ValueError('Invalid workspace policy')
    with _locked(directory) as path:
        _write(path, mode)


def policy(directory):
    try:
        with _locked(directory) as path:
            return _read(path)
    except OSError:
        return 'closed'


def settle_existing(directory):
    """A successful claim consumes a pending create permit without creating."""
    with _locked(directory) as path:
        mode = _read(path)
        if mode == 'closed':
            raise RuntimeError('Workspace was explicitly closed; an explicit user request is required to reopen it')
        if mode == 'allow-once':
            _write(path, 'existing-only')


def create_once(directory, create):
    """Consume explicit authorization before the side effect; never retry ambiguity."""
    with _locked(directory) as path:
        if _read(path) != 'allow-once':
            raise RuntimeError('Workspace creation requires an explicit user request')
        _write(path, 'existing-only')
        return create()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('closed', 'allow-once', 'status'))
    args = parser.parse_args()
    directory = state_dir()
    if args.action == 'status':
        print(policy(directory))
    else:
        set_policy(directory, args.action)
        print('Workspace creation policy recorded; no display was changed.')

if __name__ == '__main__':
    main()
