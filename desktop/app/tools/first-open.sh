#!/bin/bash
# A downloaded Hive.app sets up the same Hive the owner runs from the repository, with no clone and no
# commands (owner, 2026-11-18: "it should download the same thing i've setup on my own hive system").
# Hive.app runs this from inside itself (Contents/Resources/hive/first-open.sh) each time it opens,
# with the Hive folder to fill: a copy of the repository's layout in Hive's data folder. It only does
# what's missing, so after the first time it takes a moment.
#
#   first-open.sh <hive folder>     ~/Library/Application Support/Hive/install
#
# 1. The agent, its tools, the dashboard, the browser extension, the voice sidecars' Python files and
#    the knowledge base's schema, copied from the app when it carries a different copy than the folder
#    last got from it. Releases after that arrive by themselves (hive-tasks update.rs).
# 2. Python and the voice packages at the owner's exact versions (requirements.lock), installed with
#    the uv inside the app into desktop/app/.venv.
# 3. The voice models, from where ./voice.sh gets them: Kokoro (GitHub, checked against the owner's
#    copies), Parakeet and Silero VAD (python/listen.py --download), WeSpeaker (python/voiceprint.py
#    --download), both from Hugging Face.
# 4. Codex (the owner's version, inside the app) as <hive folder>/bin/codex, which Hive.app puts first
#    on the agent's PATH, and its sign-in: Codex opens the browser to sign in to ChatGPT once.
#
# Hive.app shows what it prints: "step: <what it's doing>", then "ready", or "error: <why>".
set -euo pipefail
contents=$(cd "$(dirname "$0")/../.." && pwd)  # Hive.app/Contents
carried="$contents/Resources/hive"
root=${1:?usage: first-open.sh <hive folder>}
app="$root/desktop/app"
step() { echo "step: $*"; }
trap 'echo "error: setup stopped (first-open.sh line $LINENO)"' ERR
mkdir -p "$root"

# 1. What the app carries, when it carries something new.
carries=$(cat "$carried/VERSION")
if [ "$(cat "$root/.from-app" 2>/dev/null || true)" != "$carries" ]; then
  step "Putting Hive's agent and tools in place"
  for part in desktop/app/build desktop/app/python desktop/app/requirements.lock browser/chrome/build cloud/knowledge/migrations; do
    [ -e "$carried/$part" ] || continue
    mkdir -p "$(dirname "$root/$part")"
    rm -rf "$root/$part.new" "$root/$part.old"
    ditto "$carried/$part" "$root/$part.new"
    if [ -e "$root/$part" ]; then mv "$root/$part" "$root/$part.old"; fi
    mv "$root/$part.new" "$root/$part"
    rm -rf "$root/$part.old"
  done
  echo "$carries" > "$root/.from-app"
fi

# 2. Python and the voice packages. uv keeps its Pythons and downloads inside the Hive folder, and
# puts nothing on the Mac's PATH.
export UV_PYTHON_INSTALL_DIR="$root/python" UV_CACHE_DIR="$root/cache/uv" UV_NO_CONFIG=1 UV_PYTHON_PREFERENCE=only-managed
uv="$contents/Helpers/uv"
lock="$app/requirements.lock"
version=$(sed -n 's/^# python: //p' "$lock")
python="$app/.venv/bin/python"
if [ ! -x "$python" ] || [ "$("$python" -c 'import platform; print(platform.python_version())' 2>/dev/null || true)" != "$version" ]; then
  step "Getting Python $version"
  "$uv" python install --quiet --no-bin "$version"
  rm -rf "$app/.venv"
  "$uv" venv --quiet --managed-python --python "$version" "$app/.venv"
fi
if [ ! -f "$app/.venv/.installed" ] || [ "$lock" -nt "$app/.venv/.installed" ]; then
  step "Installing the voice packages ($(grep -vc '^#' "$lock") of them, about 1 GB)"
  "$uv" pip sync --quiet --python "$python" "$lock"
  touch "$app/.venv/.installed"
fi

# 3. The voice models.
kokoro=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
mkdir -p "$app/models"
while read -r sum file; do
  [ -f "$app/models/$file" ] && continue
  step "Downloading Hive's voice (Kokoro, $file)"
  curl -fsSL --retry 3 -o "$app/models/$file.part" "$kokoro/$file"
  if [ "$(shasum -a 256 "$app/models/$file.part" | cut -d' ' -f1)" != "$sum" ]; then
    rm -f "$app/models/$file.part"
    echo "error: Kokoro's $file didn't match the owner's copy"
    exit 1
  fi
  mv "$app/models/$file.part" "$app/models/$file"
done <<'EOF'
7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5 kokoro-v1.0.onnx
bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d voices-v1.0.bin
EOF
if [ ! -f "$app/models/.downloaded" ] || [ "$lock" -nt "$app/models/.downloaded" ]; then
  step "Downloading what hears you (Parakeet and Silero VAD, about 2.4 GB)"
  "$python" "$app/python/listen.py" --download
  step "Downloading what tells your voice from other people's (WeSpeaker)"
  "$python" "$app/python/voiceprint.py" --download
  touch "$app/models/.downloaded"
fi
if [ ! -f "$app/models/wake/tokens.txt" ]; then
  step "Downloading what hears \"hive\" and \"bye\" (Moonshine tiny, 28 MB)"
  "$python" "$app/python/wake.py" --download
fi

# 4. Codex, and its sign-in.
mkdir -p "$root/bin"
ln -sfn "$contents/Helpers/codex/bin/codex" "$root/bin/codex"
if ! "$root/bin/codex" login status >/dev/null 2>&1; then
  step "Sign in to ChatGPT in the browser window that opened, for Codex"
  "$root/bin/codex" login </dev/null
fi
echo ready
