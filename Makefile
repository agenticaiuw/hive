KARABINER := third_party/Karabiner-DriverKit-VirtualHIDDevice
CXXFLAGS := -std=c++23 -O2 -Wall -Wextra -fblocks \
	-isystem $(KARABINER)/include -isystem $(KARABINER)/vendor/vendor/include
LDFLAGS := -framework CoreFoundation -framework IOKit

all: build/agent-vhid-helper build/agent-vhid-ocr build/agent-vhid-tap build/agent-vhid-captions \
	build/agent-vhid-paste build/Agent.app

# Build to a temporary file and rename, so a helper that's running keeps its old binary.
build/agent-vhid-helper: src/main.cpp $(wildcard src/*.hpp)
	@mkdir -p build
	clang++ $(CXXFLAGS) src/main.cpp -o $@.tmp $(LDFLAGS)
	mv $@.tmp $@

build/agent-vhid-ocr: tools/ocr.swift
	@mkdir -p build
	swiftc -O tools/ocr.swift -o $@.tmp
	mv $@.tmp $@

build/agent-vhid-tap: tools/tap.swift
	@mkdir -p build
	swiftc -O tools/tap.swift -o $@.tmp
	mv $@.tmp $@

build/agent-vhid-captions: tools/captions.swift
	@mkdir -p build
	swiftc -O tools/captions.swift -o $@.tmp
	mv $@.tmp $@

build/agent-vhid-paste: tools/paste.swift
	@mkdir -p build
	swiftc -O tools/paste.swift -o $@.tmp
	mv $@.tmp $@

# The menu bar app (tools/app.swift) that runs the voice agent from this folder; ./install.sh installs it.
build/Agent.app: tools/app.swift tools/context_panel.swift tools/Agent-Info.plist tools/sign.sh
	@rm -rf $@.tmp && mkdir -p $@.tmp/Contents/MacOS
	swiftc -O -parse-as-library tools/app.swift tools/context_panel.swift -o $@.tmp/Contents/MacOS/Agent
	sed 's|@REPO@|$(CURDIR)|' tools/Agent-Info.plist > $@.tmp/Contents/Info.plist
	tools/sign.sh $@.tmp local.personal-agent.Agent
	rm -rf $@ && mv $@.tmp $@

clean:
	rm -rf build

.PHONY: all clean
