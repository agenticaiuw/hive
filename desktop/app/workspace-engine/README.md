# Agent workspace engine

This directory contains the workspace engine source maintained in this repository.
It originated from SpaceO revision `23918951d67da6567703ecaba21b03d1c0154dd3`,
including local integration changes. Its MIT license and copyright notice are in
`LICENSE`. The build uses these files directly and does not clone the upstream repo.

The Agent app integration sources in `tools/` are copied into the build tree by
`scripts/build-spaceo.sh`; edit those integration files in `tools/`. The copy in
`build/` is disposable. Retain the display-safety rules in `docs/DISPLAY_SAFETY.md`
when changing display lifecycle code.
