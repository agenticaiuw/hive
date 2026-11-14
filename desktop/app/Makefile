KARABINER := third_party/Karabiner-DriverKit-VirtualHIDDevice
CXXFLAGS := -std=c++23 -O2 -Wall -Wextra -fblocks \
	-isystem $(KARABINER)/include -isystem $(KARABINER)/vendor/vendor/include
LDFLAGS := -framework CoreFoundation -framework IOKit
HIVE_RELEASE_DIR := $(if $(CARGO_TARGET_DIR),$(CARGO_TARGET_DIR),crates/hive/target)/release
# Every file under these folders but build output: what `rg --files` lists, without needing ripgrep.
sources = $(shell find $(1) -type f -not -path '*/target/*' -not -path '*/.build/*' -not -name .DS_Store)

# The agent itself (crates/hive, Rust): hive-agent is what Agent.app runs; the rest are the tools
# Codex, the scripts and the menu start. The voice models stay Python (python/sidecar_voice.py).
HIVE_BINS := hive-agent hive-ask hive-auth-mcp hive-phone-mcp hive-vhid hive-credentials hive-knowledge hive-session-journal hive-context-panel \
	hive-memory-search hive-ingest phone-status \
	workspace-mcp-bridge workspace-fence workspace-update workspace-tool restart-agent-once hive-bundle-migration \
	hive-app-server-transport hive-settings-reader hive-request-ledger
HIVE_BUILT := $(addprefix build/,$(HIVE_BINS))

all: build/agent-vhid-helper build/agent-vhid-ocr build/agent-vhid-tap build/agent-vhid-captions build/hive-monitor $(HIVE_BUILT) \
	build/agent-vhid-paste build/agent-vhid-selection build/Agent.app

# One cargo build for all of them; each is copied in through a temporary file and renamed, so a
# running agent keeps its old executable.
build/.hive-built: crates/hive/Cargo.toml crates/hive/Cargo.lock $(call sources,crates/hive)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/hive/Cargo.toml $(addprefix --bin ,$(HIVE_BINS))
	for bin in $(HIVE_BINS); do cp $(HIVE_RELEASE_DIR)/$$bin build/$$bin.tmp && mv build/$$bin.tmp build/$$bin; done
	touch $@

$(HIVE_BUILT): build/.hive-built
	@:

# The nightly self-review, not part of `all` (Agent.app never runs it). It runs on Hive's cloud
# VM (cloud/dream/install.sh); `make build/hive-dream` builds it here to try it by hand.
build/hive-dream: crates/hive/Cargo.toml crates/hive/Cargo.lock $(call sources,crates/hive/hive-dream)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/hive/Cargo.toml -p hive-dream --bin hive-dream
	cp $(HIVE_RELEASE_DIR)/hive-dream $@.tmp
	mv $@.tmp $@

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

# The virtual monitor: `serve` makes the display, `switch` is the right Option key that shows it.
build/hive-monitor: tools/hive_monitor.m
	@mkdir -p build
	clang -fobjc-arc -O2 -Wall tools/hive_monitor.m -o $@.tmp -framework Cocoa -framework ApplicationServices \
		-framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo -framework QuartzCore -framework IOSurface
	mv $@.tmp $@

build/agent-vhid-paste: tools/paste.swift
	@mkdir -p build
	swiftc -O tools/paste.swift -o $@.tmp
	mv $@.tmp $@

build/agent-vhid-selection: tools/selected-text.swift
	@mkdir -p build
	swiftc -O tools/selected-text.swift -o $@.tmp
	mv $@.tmp $@

# Hive.app's main executable and its virtual workspace engine: workspace-engine/Sources.
build/agent-unified-host: tools/build-workspace.sh $(call sources,workspace-engine)
	bash tools/build-workspace.sh

build/workspace-engine: build/agent-unified-host
	@:

# Hive's icon is drawn once, in branding/hive.svg at the repository's root; the app's .icns is
# built from it. The other places' PNGs are kept in git: `node branding/sync-icons.mjs`.
build/hive-icon: tools/hive-icon.swift
	@mkdir -p build
	swiftc -O tools/hive-icon.swift -o $@.tmp
	mv $@.tmp $@

build/Hive.icns: ../../branding/hive.svg build/hive-icon
	build/hive-icon ../../branding/hive.svg icns build/Hive.tmp.icns
	mv build/Hive.tmp.icns $@

build/Agent.app: build/agent-unified-host build/workspace-engine build/Hive.icns tools/Agent-Info.plist tools/sign.sh $(call sources,workspace-engine)
	@rm -rf $@.tmp && mkdir -p $@.tmp/Contents/MacOS $@.tmp/Contents/Resources $@.tmp/Contents/Helpers
	cp build/agent-unified-host $@.tmp/Contents/MacOS/Agent
	cp build/workspace-engine $@.tmp/Contents/Helpers/workspace-engine
	tools/sign.sh $@.tmp/Contents/Helpers/workspace-engine local.personal-agent.workspace-engine
	cp build/Hive.icns $@.tmp/Contents/Resources/Hive.icns
	sed 's|@REPO@|$(CURDIR)|' tools/Agent-Info.plist > $@.tmp/Contents/Info.plist
	tools/sign.sh $@.tmp local.personal-agent.Agent
	codesign --verify --deep --strict $@.tmp
	rm -rf $@ && mv $@.tmp $@

clean:
	rm -rf build

.PHONY: all clean
