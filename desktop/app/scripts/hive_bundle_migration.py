#!/usr/bin/env python3
"""Atomic bundle moves for the Agent.app to Hive.app migration.

All paths are supplied by the updater. Backups are retained without an .app suffix.
"""
from pathlib import Path
import argparse
import ctypes
import os
import sys
import subprocess


def _present(path):
    return path.exists() or path.is_symlink()


def _move(source, target):
    """Atomically rename without replacing an unexpected destination."""
    if sys.platform != 'darwin':
        raise RuntimeError('Exclusive bundle migration requires macOS')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(source), os.fsencode(target), 0x00000004) != 0:  # RENAME_EXCL
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def select_installed(applications):
    applications = Path(applications)
    legacy, hive = applications / 'Agent.app', applications / 'Hive.app'
    for path in (legacy, hive):
        if path.is_symlink() or (_present(path) and not path.is_dir()):
            raise RuntimeError(f'Unexpected application path: {path}')
    if _present(legacy) and _present(hive):
        raise RuntimeError('Both Agent.app and Hive.app exist; refusing to choose or overwrite either')
    return legacy if _present(legacy) else hive if _present(hive) else None


def login_control(bundle, operation):
    """Ask the signed app at this exact bundle path; never infer a preference."""
    result = subprocess.run([str(bundle / 'Contents/MacOS/Agent'), '--login-' + operation],
                            check=True, capture_output=True, text=True, timeout=15)
    value = result.stdout.strip()
    if value not in ('enabled', 'notRegistered', 'notFound', 'requiresApproval'):
        raise RuntimeError('Login item state is unavailable')
    return value


def _restore_legacy(installed, target, staged, backup, prior, registration_may_have_changed, control):
    # Restore the old URL's effective registration before restoring its signed bundle.
    # If both exist, the target appeared concurrently; it is not our candidate.
    if _present(target) and not _present(staged):
        if registration_may_have_changed:
            state = control(target, 'status')
            if state == 'enabled': control(target, 'unregister')
            elif state not in ('notRegistered', 'notFound'): raise RuntimeError('New login state is uncertain')
        _move(target, staged)
    if not _present(installed) and _present(staged) and registration_may_have_changed:
        _move(staged, installed)
    if _present(installed):
        if registration_may_have_changed and prior == 'enabled':
            state = control(installed, 'status')
            if state != 'enabled':
                if state not in ('notRegistered', 'notFound') or control(installed, 'register') != 'enabled':
                    raise RuntimeError('Could not restore the previous login item')
        if _present(staged): raise RuntimeError('Cannot safely retain the staged bundle')
        _move(installed, staged)
    if not _present(backup) or _present(installed):
        raise RuntimeError('Cannot safely restore the previous application')
    _move(backup, installed)


def commit(installed, target, staged, backup, control=login_control):
    installed = Path(installed) if installed else None
    target, staged, backup = map(Path, (target, staged, backup))
    if len({p for p in (installed, target, staged, backup) if p is not None}) != (4 if installed and installed != target else 3):
        raise RuntimeError('Application paths overlap')
    if staged.is_symlink() or not staged.is_dir() or _present(backup):
        raise RuntimeError('Staged bundle or backup path is unsafe')
    if installed is None:
        if _present(target): raise RuntimeError('Destination appeared during staging')
    else:
        if installed.is_symlink() or not installed.is_dir(): raise RuntimeError('Installed bundle changed during staging')
        if installed != target and _present(target): raise RuntimeError('Destination appeared during staging')
    if backup.parent.is_symlink() or (_present(backup.parent) and not backup.parent.is_dir()):
        raise RuntimeError('Backup directory is unsafe')
    backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if installed is not None: _move(installed, backup)
    if installed is None or installed == target:
        try:
            _move(staged, target)
        except OSError:
            if installed is not None and not _present(installed): _move(backup, installed)
            raise
        return 'unchanged'
    prior = None
    changed = False
    try:
        # Run the verified candidate at the *old bundle URL* to query its effective
        # SMAppService state, without opening its UI or relying on preferences.
        _move(staged, installed)
        prior = control(installed, 'status')
        if prior not in ('enabled', 'notRegistered', 'notFound'):
            raise RuntimeError('Existing login item requires attention; no migration performed')
        if prior == 'enabled':
            changed = True  # even a failed call can have changed registration
            state = control(installed, 'unregister')
            if state not in ('notRegistered', 'notFound'):
                raise RuntimeError('Could not confirm old login item removal')
        _move(installed, staged)
        _move(staged, target)
        if prior == 'enabled' and control(target, 'register') != 'enabled':
            raise RuntimeError('Could not confirm Hive login item registration')
        return prior
    except Exception:
        _restore_legacy(installed, target, staged, backup, prior, changed, control)
        raise


def rollback(installed, target, staged, backup, prior='unchanged', control=login_control):
    installed = Path(installed) if installed else None
    target, staged, backup = map(Path, (target, staged, backup))
    if target.is_symlink() or not target.is_dir() or _present(staged):
        raise RuntimeError('Cannot safely roll back the new application')
    if installed is not None and (backup.is_symlink() or not backup.is_dir() or (installed != target and _present(installed))):
        raise RuntimeError('Cannot safely restore the prior application')
    if installed is not None and installed != target:
        _restore_legacy(installed, target, staged, backup, prior, prior == 'enabled', control)
        return
    _move(target, staged)
    try:
        if installed is not None: _move(backup, installed)
    except OSError:
        if not _present(target): _move(staged, target)
        raise

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('select', 'commit', 'rollback'))
    parser.add_argument('paths', nargs='+')
    args = parser.parse_args()
    if args.operation == 'select' and len(args.paths) == 1:
        print(select_installed(args.paths[0]) or '')
    elif args.operation == 'commit' and len(args.paths) == 4:
        installed, target, staged, backup = args.paths
        print(commit(installed or None, target, staged, backup))
    elif args.operation == 'rollback' and len(args.paths) == 5:
        installed, target, staged, backup, prior = args.paths
        rollback(installed or None, target, staged, backup, prior)
    else:
        parser.error('Invalid arguments')


if __name__ == '__main__':
    main()
