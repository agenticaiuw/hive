"""Durable UI request admissions in the shared private ingress ledger."""
import json
import subprocess
import uuid
from pathlib import Path
from resumable_thread import state_dir

LEDGER = Path(__file__).resolve().parent.parent / 'build/agent-request-ledger'


def _request(operation, value):
    result = subprocess.run([str(LEDGER), str(state_dir() / 'control'), operation],
                            input=json.dumps(value, ensure_ascii=False), text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=5, check=True)
    response = json.loads(result.stdout)
    if not isinstance(response, dict):
        raise ValueError('Invalid receipt response')
    return response


def admit(text, channel):
    source = f'ui:{channel}:{uuid.uuid4().hex}'
    response = _request('admit', {'sourceId': source, 'text': text})
    if response.get('duplicate') or not isinstance(response.get('receiptId'), str):
        raise ValueError('Request admission was not confirmed')
    return response['receiptId']


def finish(receipt, status):
    return _request('finish', {'receiptId': receipt, 'status': status})
