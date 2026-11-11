//
//  SpaceOPrivate.h
//  The one place in SpaceO that touches private macOS API.
//
//  Private operations are available when their runtime symbol or Objective-C surface exists.
//  Callers still receive explicit unavailable errors when the current macOS build lacks an API.
//
#ifndef SPACEO_PRIVATE_H
#define SPACEO_PRIVATE_H

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ApplicationServices/ApplicationServices.h>

NS_ASSUME_NONNULL_BEGIN

#pragma mark - Runtime capabilities

typedef NS_ENUM(NSInteger, SPOCapability) {
    /// CGVirtualDisplay + descriptor/mode/settings classes (the agent's stage).
    SPOCapabilityVirtualDisplay = 0,
    /// Removed private focus-record path; direct per-PID delivery remains available.
    SPOCapabilityFocusWithoutRaise,
    /// SLSCopyManagedDisplaySpaces & friends — read the Space graph.
    SPOCapabilitySpaceQuery,
    /// CGEventPostToPid — per-process event delivery (public, but we verify it anyway).
    SPOCapabilityPerPIDEvents,
    /// _AXUIElementGetWindow — map an AX element to a CGWindowID.
    SPOCapabilityAXWindowID,
    SPOCapabilityCount
};

/// YES when the runtime surface is available. The removed focus-record capability stays NO.
BOOL SPOCapabilityAvailable(SPOCapability cap);
NSString *SPOCapabilityName(SPOCapability cap);
/// Nil when available; otherwise a user-facing runtime reason.
NSString *_Nullable SPOCapabilityUnavailableReason(SPOCapability cap);
NSArray<NSString *> *SPOMissingSymbols(void);

/// Whether this translation unit was compiled with ARC.
///
/// Not trivia: a virtual display is removed only when its CGVirtualDisplay is deallocated, so
/// if ARC were off, teardown would silently leak a phantom monitor. Surfaced in `spaceo doctor`.
BOOL SPOBuiltWithARC(void);

#pragma mark - Stage: headless virtual display

/// Wrapper around a private virtual display. Normal invalidation releases its backing object;
/// higher-level code verifies and reports removal.
@interface SPOVirtualDisplay : NSObject

/// `serial` is the display's persistent hardware identity to WindowServer and ColorSync, which
/// keep per-identity state forever; pass a value from a bounded set. Zero picks a random serial
/// (the historical behavior, which grows that state with every attachment).
- (nullable instancetype)initWithName:(NSString *)name
                                width:(uint32_t)width
                               height:(uint32_t)height
                                hiDPI:(BOOL)hiDPI
                               serial:(uint32_t)serial NS_DESIGNATED_INITIALIZER;
- (nullable instancetype)initWithName:(NSString *)name
                                width:(uint32_t)width
                               height:(uint32_t)height
                                hiDPI:(BOOL)hiDPI;
- (instancetype)init NS_UNAVAILABLE;

/// NO when the display attached but its mode settings were refused. The object still owns the
/// attached display so the caller can retain it rather than releasing it implicitly.
@property (nonatomic, readonly) BOOL settingsApplied;
@property (nonatomic, readonly) CGDirectDisplayID displayID;
@property (nonatomic, readonly) BOOL valid;
@property (nonatomic, readonly) CGRect bounds;

/// Drop the display now rather than waiting for dealloc.
- (void)invalidate;

@end

#pragma mark - Space graph (read-only)

/// Managed space ids belonging to `displayID`, matched on that display's UUID alone.
///
/// Nil when the Space API is unavailable or the display has no UUID to match against; empty
/// when no managed display entry is this display. Never another display's Spaces — the result
/// decides which Spaces count as agent territory, so a guess reports the user's own Space as a
/// breach. Callers must treat an absent or empty answer as "unknown", not "no Spaces exist".
NSArray<NSNumber *> *_Nullable SPOSpacesForDisplay(CGDirectDisplayID displayID);
NSArray<NSNumber *> *_Nullable SPOSpacesForWindow(uint32_t windowID);
/// The user's currently active space id (0 when unavailable).
uint64_t SPOActiveSpace(void);
/// Raw SLSCopyManagedDisplaySpaces payload, for `spaceo doctor` diagnostics.
NSArray *_Nullable SPOManagedDisplaySpaces(void);

#pragma mark - Focus routing

/// Result of the three-record private focus transaction.
///
/// A private record can mutate WindowServer state even when it returns an error, so every
/// result after a record was attempted is explicitly mutation-possible.
typedef NS_ENUM(NSInteger, SPOFocusResult) {
    /// No private record was posted (symbol/process lookup failed).
    SPOFocusResultNotAttempted = 0,
    /// The activation record was attempted and may have mutated the global input route.
    SPOFocusResultFailedAfterActivationRecord,
    /// The key-window-down record was attempted after activation and may have partially applied.
    SPOFocusResultFailedAfterKeyDownRecord,
    /// The key-window-up record was attempted and may have partially applied.
    SPOFocusResultFailedAfterKeyUpRecord,
    /// All three records were accepted.
    SPOFocusResultSucceeded,
};

/// Flip `pid`'s AppKit-active state so it receives input, WITHOUT raising the window and
/// WITHOUT switching the user's Space.
///
/// This deliberately does not call SLPSSetFrontProcessWithOptions — that is the single API
/// that would raise the window and drag the user to the app's Space.
///
/// Reports whether no record was attempted, all records succeeded, or which attempted record
/// failed after the transaction had become mutation-possible.
SPOFocusResult SPOFocusWithoutRaiseResult(pid_t pid, uint32_t windowID);

/// Compatibility wrapper. Prefer `SPOFocusWithoutRaiseResult` so failure is not mistaken for
/// proof that the input route was unchanged.
BOOL SPOFocusWithoutRaise(pid_t pid, uint32_t windowID);

/// Legacy ABI-compatible stub. Always returns 0.
///
/// SpaceO deliberately does not call the private front-process getter; AppKit provides the
/// frontmost application without another guessed private ProcessSerialNumber ABI.
pid_t SPOFrontProcessPID(void);

#pragma mark - Window geometry

/// Window bounds straight from the WindowServer. Works for windows on any display or Space,
/// including ones the user cannot see.
BOOL SPOWindowBounds(uint32_t windowID, CGRect *outBounds);

/// CGWindowID behind an accessibility element, or 0.
uint32_t SPOWindowIDForAXElement(AXUIElementRef element);

/// Preserve the provider status for callers that must distinguish a busy app from a stale
/// element. The output is zero on every failure; a successful zero still means unresolved.
AXError SPOGetWindowIDForAXElement(AXUIElementRef _Nullable element,
                                  uint32_t *_Nullable outWindowID);

#pragma mark - Per-process event delivery

/// Post through the resolved per-PID event symbol.
/// Returns NO without posting when the symbol is unavailable.
BOOL SPOPostEventToPID(pid_t pid, CGEventRef event);

#pragma mark - Viewer host-input capture

/// Enable or disable WindowServer global hotkeys for this process's active capture session.
///
/// This is the same narrow mechanism VM consoles use so Command-Tab, Mission Control, and
/// similar host shortcuts can be delivered to the remote surface. Callers must always pair a
/// disable with an enable; failure to resolve the runtime symbols returns NO without mutation.
BOOL SPOSetGlobalHotKeysEnabled(BOOL enabled);

NS_ASSUME_NONNULL_END

#endif /* SPACEO_PRIVATE_H */
