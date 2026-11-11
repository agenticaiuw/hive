#!/bin/bash
# Signs what make builds. With your "Apple Development" certificate, when the keychain has one,
# macOS keeps the permissions you gave Agent.app and the helper when they're rebuilt: it knows them
# by their identifier and your certificate, which stay the same. Signed ad hoc (SIGN=- make, or no
# certificate), macOS knows them only by the exact build, so each rebuild has to be allowed again.
#
#   tools/sign.sh PATH IDENTIFIER
#
#   SIGN=-             sign ad hoc on purpose (permissions won't survive a rebuild)
#   SIGN=<hash>        sign with that certificate
#   SIGN_REQUIRED=1    fail rather than fall back to ad hoc (install.sh sets it)
#
# The first time, macOS asks whether codesign may use your certificate's key ("codesign wants to
# sign using key ... in your keychain"): type your login password and choose Always Allow, or each
# build asks again. That is your keychain's own protection; nothing here changes it.
set -uo pipefail
target=$1 identifier=$2
identity=${SIGN-$(security find-identity -v -p codesigning 2>/dev/null | awk '/"Apple Development: / {print $2; exit}')}
if [ "$identity" = "-" ]; then
  exec codesign --force --sign - --identifier "$identifier" "$target"
fi
# A keychain prompt nobody answers would hold make up forever; after 60 s it gives up.
if [ -n "$identity" ] &&
   perl -e 'alarm 60; exec @ARGV' codesign --force --sign "$identity" --identifier "$identifier" "$target"; then
  exit 0
fi
why="no Apple Development certificate in your keychain"
[ -n "$identity" ] && why="codesign couldn't use your certificate (the keychain prompt wasn't answered in time, or was denied)"
if [ "${SIGN_REQUIRED:-}" = 1 ]; then
  echo "✗ Not signing $target ad hoc: $why. An ad-hoc build loses the macOS permissions you gave it." >&2
  echo "  Run it again and allow the keychain prompt (Always Allow), or SIGN=- to sign ad hoc anyway." >&2
  exit 1
fi
echo "⚠️  Signing $target ad hoc: $why. macOS will ask for its permissions again." >&2
exec codesign --force --sign - --identifier "$identifier" "$target"
