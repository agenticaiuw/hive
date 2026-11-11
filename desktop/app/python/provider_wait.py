"""Bounded provider availability checks through the user's configured HTTPS proxy."""
import fcntl
import http.client
import json
import time
import urllib.parse
import urllib.request
from resumable_thread import atomic_write, state_dir

INTERVAL_SECONDS = 300
MAX_CHECKS = 288  # no more than 24 hours of checks


def arm(identity, now=None):
    """Persist a wait without making a network request or consuming a check."""
    now = time.time() if now is None else now
    path = state_dir() / 'provider-wait.json'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(str(path) + '.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            record = json.loads(path.read_text())
            if not isinstance(record, dict) or record.get('version') != 1:
                raise ValueError('invalid provider wait state')
        except FileNotFoundError:
            record = None
        if record and record.get('identity') == identity:
            return not record.get('resolved', False)
        atomic_write(path, json.dumps({'version': 1, 'identity': identity,
                                       'checks': 0, 'next': now}) + '\n')
        return True


def reserve(identity, now=None, arm=False):
    """Persist the next check before making it, so crashes cannot cause a tight loop."""
    now = time.time() if now is None else now
    path = state_dir() / 'provider-wait.json'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(str(path) + '.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            record = json.loads(path.read_text())
            if not isinstance(record, dict) or record.get('version') != 1:
                raise ValueError('invalid provider wait state')
        except FileNotFoundError:
            record = None
        if not record or record.get('identity') != identity:
            if not arm:
                return None
            record = {'version': 1, 'identity': identity, 'checks': 0, 'next': now}
        elif record.get('resolved'):
            if not arm:
                return None
            record['resolved'] = False
            atomic_write(path, json.dumps(record) + '\n')
        checks, due = record.get('checks'), record.get('next')
        if not isinstance(checks, int) or not isinstance(due, (int, float)):
            raise ValueError('invalid provider wait state')
        if checks >= MAX_CHECKS:
            return {'state': 'expired'}
        if now < due:
            return {'state': 'waiting', 'delay': min(INTERVAL_SECONDS, due - now)}
        record['checks'], record['next'] = checks + 1, now + INTERVAL_SECONDS
        atomic_write(path, json.dumps(record) + '\n')
        return {'state': 'check'}


def exists(identity):
    return status(identity) == 'waiting'


def status(identity):
    path = state_dir() / 'provider-wait.json'
    try:
        record = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    if not isinstance(record, dict) or record.get('version') != 1:
        raise ValueError('invalid provider wait state')
    if record.get('identity') != identity:
        return None
    return 'resolved' if record.get('resolved', False) else 'waiting'


def resolve(identity):
    path = state_dir() / 'provider-wait.json'
    with open(str(path) + '.lock', 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = json.loads(path.read_text())
        if record.get('identity') != identity:
            return False
        record['resolved'] = True
        atomic_write(path, json.dumps(record) + '\n')
        return True


def workspace_open():
    """A closed or unknown workspace viewer must never be reopened by recovery."""
    try:
        return (state_dir() / 'workspace-viewer-visible').read_text().strip() == '1'
    except OSError:
        return False


def reachable():
    """Probe only via the configured HTTPS proxy; never fall back to a direct connection."""
    proxy = urllib.request.getproxies().get('https')
    if not proxy:
        return False
    parsed = urllib.parse.urlsplit(proxy if '://' in proxy else 'http://' + proxy)
    if parsed.scheme != 'http' or not parsed.hostname or parsed.username or parsed.password:
        return False
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 80, timeout=8)
    try:
        connection.set_tunnel('chatgpt.com', 443)
        connection.request('HEAD', '/')
        response = connection.getresponse()
        return 200 <= response.status < 400
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()
