#!/usr/bin/env python3
"""Copy a verified installed dependency closure into a fresh Hive venv.

Run with the old environment's interpreter. No source files are changed; only
package-owned files under its site-packages are copied. This is an offline,
machine-specific fallback, not a dependency lockfile or a portable build.
"""
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

if len(sys.argv) != 2:
    raise SystemExit('Usage: OLD_VENV/bin/python copy-hive-python-deps.py NEW_VENV')
target = Path(sys.argv[1]).resolve()
new_python = target / 'bin/python'
version = subprocess.check_output([str(new_python), '-c', 'import sys;print(".".join(map(str,sys.version_info[:3])))'], text=True).strip()
if version != '.'.join(map(str, sys.version_info[:3])):
    raise SystemExit('Python versions differ; refusing package copy')
source_site = (Path(sys.prefix) / f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages').resolve()
target_site = target / f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
if not source_site.is_dir() or not target_site.is_dir() or source_site == target_site.resolve():
    raise SystemExit('Expected two distinct virtual environments')
if any(path.name not in {'_virtualenv.py', '_virtualenv.pth', '__pycache__'} for path in target_site.iterdir()):
    raise SystemExit('Target environment is not empty; refusing to overwrite')
queue = ['parakeet-mlx', 'kokoro-onnx', 'sounddevice', 'livekit', 'soxr', 'kaldi-native-fbank']
selected = {}
while queue:
    name = queue.pop()
    key = canonicalize_name(name)
    if key in selected:
        continue
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError as error:
        raise SystemExit(f'Required dependency is missing: {name}') from error
    selected[key] = dist
    for requirement in dist.requires or []:
        parsed = Requirement(requirement)
        if parsed.marker is None or parsed.marker.evaluate({'extra': ''}):
            queue.append(parsed.name)
for dist in selected.values():
    for requirement in dist.requires or []:
        parsed = Requirement(requirement)
        if parsed.marker is not None and not parsed.marker.evaluate({'extra': ''}):
            continue
        dependency = selected.get(canonicalize_name(parsed.name))
        if dependency is None or (parsed.specifier and not parsed.specifier.contains(dependency.version, prereleases=True)):
            raise SystemExit(f'Installed dependency version does not satisfy {parsed.name}')
requirements_file = target.parent / 'requirements.txt'
for line in requirements_file.read_text().splitlines():
    line = line.split('#', 1)[0].strip()
    if not line:
        continue
    parsed = Requirement(line)
    dist = selected.get(canonicalize_name(parsed.name))
    if dist is None or (parsed.specifier and not parsed.specifier.contains(dist.version, prereleases=True)):
        raise SystemExit(f'Installed dependency version does not satisfy {parsed.name}')
files = {}
for dist in selected.values():
    if dist.files is None:
        raise SystemExit('A dependency has no file manifest; refusing package copy')
    for entry in dist.files:
        source = Path(dist.locate_file(entry))
        try:
            relative = source.relative_to(source_site)
        except ValueError:
            continue  # console scripts outside site-packages are not copied
        if '..' in relative.parts:
            continue  # do not copy console scripts outside site-packages
        if '__pycache__' in relative.parts:
            continue
        if not source.is_file() or source.is_symlink():
            raise SystemExit(f'Dependency contains a missing or linked file: {dist.metadata["Name"]}')
        if relative.suffix == '.pth':
            raise SystemExit('Dependency includes a path hook; review before copy')
        if not source.resolve().is_relative_to(source_site):
            raise SystemExit(f'Dependency escapes the source environment: {dist.metadata["Name"]}')
        files[relative] = source
marker = target / '.hive-package-copy-incomplete'
marker.touch(exist_ok=False)
for relative, source in files.items():
    destination = target_site / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as inp, destination.open('xb') as out:
        shutil.copyfileobj(inp, out, 1024 * 1024)
    os.chmod(destination, source.stat().st_mode & 0o777)
    def digest(path):
        h = hashlib.sha256()
        with path.open('rb') as f:
            for block in iter(lambda: f.read(1024 * 1024), b''):
                h.update(block)
        return h.digest()
    if digest(source) != digest(destination):
        raise SystemExit('Package copy did not verify; incomplete marker retained')
marker.unlink()
print(json.dumps({'packages': len(selected), 'files': len(files)}))
