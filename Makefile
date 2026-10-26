KARABINER := third_party/Karabiner-DriverKit-VirtualHIDDevice
CXXFLAGS := -std=c++23 -O2 -Wall -Wextra -fblocks \
	-isystem $(KARABINER)/include -isystem $(KARABINER)/vendor/vendor/include
LDFLAGS := -framework CoreFoundation -framework IOKit

all: build/agent-vhid-helper build/agent-vhid-ocr

# Build to a temporary file and rename, so a helper that's running keeps its old binary.
build/agent-vhid-helper: src/main.cpp $(wildcard src/*.hpp)
	@mkdir -p build
	clang++ $(CXXFLAGS) src/main.cpp -o $@.tmp $(LDFLAGS)
	mv $@.tmp $@

build/agent-vhid-ocr: tools/ocr.swift
	@mkdir -p build
	swiftc -O tools/ocr.swift -o $@.tmp
	mv $@.tmp $@

clean:
	rm -rf build

.PHONY: all clean
