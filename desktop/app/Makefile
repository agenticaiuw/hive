KARABINER := third_party/Karabiner-DriverKit-VirtualHIDDevice
CXXFLAGS := -std=c++23 -O2 -Wall -Wextra -fblocks \
	-isystem $(KARABINER)/include -isystem $(KARABINER)/vendor/vendor/include
LDFLAGS := -framework CoreFoundation -framework IOKit
CARGO_RELEASE_DIR := $(if $(CARGO_TARGET_DIR),$(CARGO_TARGET_DIR),crates/agent-core/target)/release
HIVE_RELEASE_DIR := $(if $(CARGO_TARGET_DIR),$(CARGO_TARGET_DIR),crates/hive/target)/release
# Every file under these folders but build output: what `rg --files` lists, without needing ripgrep.
sources = $(shell find $(1) -type f -not -path '*/target/*' -not -path '*/.build/*' -not -name .DS_Store)

# The agent itself (crates/hive, Rust): hive-agent is what Agent.app runs; the rest are the tools
# Codex, the scripts and the menu start. The voice models stay Python (python/sidecar_voice.py).
HIVE_BINS := hive-agent hive-auth-mcp hive-vhid hive-credentials hive-knowledge hive-session-journal hive-context-panel \
	hive-memory-search hive-ingest phone-status \
	spaceo-mcp-bridge workspace-fence workspace-update workspace-tool restart-agent-once hive-bundle-migration
HIVE_BUILT := $(addprefix build/,$(HIVE_BINS))

all: build/agent-vhid-helper build/agent-vhid-ocr build/agent-vhid-tap build/agent-vhid-captions $(HIVE_BUILT) \
	build/agent-vhid-paste build/agent-vhid-selection build/agent-workspace-client build/agent-thread-identity build/agent-memory-store build/agent-local-requests build/agent-settings-reader build/agent-memory-search build/agent-ingest-split build/agent-journal-reader build/libagent-core.dylib build/agent-app-server-transport build/agent-request-ledger build/Agent.app

# One cargo build for all of them; each is copied in through a temporary file and renamed, so a
# running agent keeps its old executable.
build/.hive-built: crates/hive/Cargo.toml crates/hive/Cargo.lock $(call sources,crates/hive crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/hive/Cargo.toml $(addprefix --bin ,$(HIVE_BINS))
	for bin in $(HIVE_BINS); do cp $(HIVE_RELEASE_DIR)/$$bin build/$$bin.tmp && mv build/$$bin.tmp build/$$bin; done
	touch $@

$(HIVE_BUILT): build/.hive-built
	@:

# Compiled separately from the running agent so updates never replace a live executable in place.
build/agent-workspace-client: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin workspace-client
	cp $(CARGO_RELEASE_DIR)/workspace-client $@.tmp
	mv $@.tmp $@

build/agent-request-ledger: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin request-ledger
	cp $(CARGO_RELEASE_DIR)/request-ledger $@.tmp
	mv $@.tmp $@

build/agent-app-server-transport: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin app-server-transport
	cp $(CARGO_RELEASE_DIR)/app-server-transport $@.tmp
	mv $@.tmp $@

build/libagent-core.dylib: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --lib
	cp $(CARGO_RELEASE_DIR)/libpersonal_agent_core.dylib $@.tmp
	mv $@.tmp $@

build/agent-journal-reader: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin journal-reader
	cp $(CARGO_RELEASE_DIR)/journal-reader $@.tmp
	mv $@.tmp $@

build/agent-ingest-split: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin ingest-split
	cp $(CARGO_RELEASE_DIR)/ingest-split $@.tmp
	mv $@.tmp $@

build/agent-memory-search: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin memory-search-reader
	cp $(CARGO_RELEASE_DIR)/memory-search-reader $@.tmp
	mv $@.tmp $@

build/agent-settings-reader: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin settings-reader
	cp $(CARGO_RELEASE_DIR)/settings-reader $@.tmp
	mv $@.tmp $@

build/agent-local-requests: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin local-requests
	cp $(CARGO_RELEASE_DIR)/local-requests $@.tmp
	mv $@.tmp $@

build/agent-memory-store: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin memory-store
	cp $(CARGO_RELEASE_DIR)/memory-store $@.tmp
	mv $@.tmp $@

build/agent-thread-identity: crates/agent-core/Cargo.toml crates/agent-core/Cargo.lock $(call sources,crates/agent-core/src)
	@mkdir -p build
	cargo build --locked --release --manifest-path crates/agent-core/Cargo.toml --bin thread-identity
	cp $(CARGO_RELEASE_DIR)/thread-identity $@.tmp
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

build/agent-vhid-paste: tools/paste.swift
	@mkdir -p build
	swiftc -O tools/paste.swift -o $@.tmp
	mv $@.tmp $@

build/agent-vhid-selection: tools/selected-text.swift
	@mkdir -p build
	swiftc -O tools/selected-text.swift -o $@.tmp
	mv $@.tmp $@

# Optional standalone host, built from the repository's maintained workspace source.
build/agent-unified-host: tools/build-workspace.sh scripts/build-spaceo.sh $(call sources,workspace-engine)
	bash tools/build-workspace.sh

# Staged multi-window implementation. It is intentionally separate until the display and
# takeover have been verified on this Mac; the normal installed Agent remains usable.
build/Agent-WorkspaceCandidate.app: build/agent-workspace-client build/agent-thread-identity build/agent-memory-store build/agent-local-requests build/agent-settings-reader build/agent-memory-search build/agent-ingest-split build/agent-journal-reader build/libagent-core.dylib build/agent-app-server-transport build/agent-request-ledger scripts/build-spaceo.sh tools/Hive.icns tools/Agent-Info.plist $(call sources,workspace-engine)
	SIGN_REQUIRED=1 bash scripts/build-spaceo.sh
	@rm -rf $@.tmp && mkdir -p $@.tmp/Contents/MacOS $@.tmp/Contents/Helpers $@.tmp/Contents/Resources
	cp build/spaceo-candidate/agent-unified-host $@.tmp/Contents/MacOS/Agent
	cp build/spaceo-candidate/spaceo $@.tmp/Contents/Helpers/spaceo
	cp build/spaceo-candidate/LICENSE $@.tmp/Contents/Resources/SpaceO-LICENSE
	cp tools/Hive.icns $@.tmp/Contents/Resources/Hive.icns
	sed 's|@REPO@|$(CURDIR)|' tools/Agent-Info.plist > $@.tmp/Contents/Info.plist
	plutil -replace AgentWorkspaceDefault -string 1 $@.tmp/Contents/Info.plist
	SIGN_REQUIRED=1 tools/sign.sh $@.tmp local.personal-agent.Agent
	codesign --verify --deep --strict $@.tmp
	rm -rf $@ && mv $@.tmp $@

build/Agent.app: build/agent-workspace-client build/agent-thread-identity build/agent-memory-store build/agent-local-requests build/agent-settings-reader build/agent-memory-search build/agent-ingest-split build/agent-journal-reader build/libagent-core.dylib build/agent-app-server-transport build/agent-request-ledger scripts/build-spaceo.sh tools/Hive.icns tools/Agent-Info.plist tools/sign.sh $(call sources,workspace-engine safari-hive-extension) $(shell find ../../browser/safari -type f | sed 's/ /\\ /g')
	bash scripts/build-spaceo.sh
	@rm -rf $@.tmp && mkdir -p $@.tmp/Contents/MacOS $@.tmp/Contents/Helpers $@.tmp/Contents/Resources
	cp build/spaceo-candidate/agent-unified-host $@.tmp/Contents/MacOS/Agent
	cp build/spaceo-candidate/spaceo $@.tmp/Contents/Helpers/spaceo
	cp build/spaceo-candidate/LICENSE $@.tmp/Contents/Resources/SpaceO-LICENSE
	cp tools/Hive.icns $@.tmp/Contents/Resources/Hive.icns
	sed 's|@REPO@|$(CURDIR)|' tools/Agent-Info.plist > $@.tmp/Contents/Info.plist
	bash safari-hive-extension/embed.sh $@.tmp
	tools/sign.sh $@.tmp local.personal-agent.Agent
	codesign --verify --deep --strict $@.tmp
	rm -rf $@ && mv $@.tmp $@

clean:
	rm -rf build

.PHONY: all clean
