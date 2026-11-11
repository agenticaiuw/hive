//
//  SpaceOPrivate.m
//
#import "SpaceOPrivate.h"
#import <dlfcn.h>
#import <math.h>
#import <objc/runtime.h>

// GetProcessForPID/GetProcessPID are soft-deprecated but remain the only way to obtain the
// ProcessSerialNumber that SLPSPostEventRecordTo requires. There is no replacement.
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

#pragma mark - Lazy symbol resolution

typedef int CGSConnectionID;

static CGSConnectionID (*p_SLSMainConnectionID)(void);
static CFArrayRef (*p_SLSCopyManagedDisplaySpaces)(CGSConnectionID);
static CFArrayRef (*p_SLSCopySpacesForWindows)(CGSConnectionID, int, CFArrayRef);
static uint64_t   (*p_SLSGetActiveSpace)(CGSConnectionID);
static OSStatus   (*p_SLPSPostEventRecordTo)(ProcessSerialNumber *, uint8_t *);
static CGError    (*p_SLSGetWindowBounds)(CGSConnectionID, uint32_t, CGRect *);
static AXError    (*p_AXUIElementGetWindow)(AXUIElementRef, uint32_t *);
static void       (*p_CGEventPostToPid)(pid_t, CGEventRef);
static CGError    (*p_CGSSetGlobalHotKeyOperatingMode)(CGSConnectionID, uint32_t);

static NSMutableArray<NSString *> *g_missing = nil;

static void *resolve(void *handle, const char *name) {
    void *sym = dlsym(handle, name);
    if (!sym) [g_missing addObject:@(name)];
    return sym;
}

static void SPOLoad(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_missing = [NSMutableArray array];

        void *sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
                           RTLD_LAZY | RTLD_LOCAL);
        if (!sky) {
            [g_missing addObject:@"SkyLight.framework"];
        } else {
            p_SLSMainConnectionID         = resolve(sky, "SLSMainConnectionID");
            p_SLSCopyManagedDisplaySpaces = resolve(sky, "SLSCopyManagedDisplaySpaces");
            p_SLSCopySpacesForWindows     = resolve(sky, "SLSCopySpacesForWindows");
            p_SLSGetActiveSpace           = resolve(sky, "SLSGetActiveSpace");
            p_SLPSPostEventRecordTo       = resolve(sky, "SLPSPostEventRecordTo");
            p_SLSGetWindowBounds          = resolve(sky, "SLSGetWindowBounds");
            p_CGSSetGlobalHotKeyOperatingMode =
                resolve(sky, "CGSSetGlobalHotKeyOperatingMode");
        }

        // _AXUIElementGetWindow lives in the (public) HIServices sub-framework but is not declared.
        void *self_handle = dlopen(NULL, RTLD_LAZY);
        p_AXUIElementGetWindow = resolve(self_handle, "_AXUIElementGetWindow");
        p_CGEventPostToPid = (void (*)(pid_t, CGEventRef))
            resolve(self_handle, "CGEventPostToPid");

        // The virtual-display classes are ObjC, so presence is a class lookup, not a dlsym.
        const char *classes[] = { "CGVirtualDisplay", "CGVirtualDisplayDescriptor",
                                  "CGVirtualDisplayMode", "CGVirtualDisplaySettings" };
        for (size_t i = 0; i < sizeof(classes) / sizeof(*classes); i++)
            if (!objc_getClass(classes[i])) [g_missing addObject:@(classes[i])];
    });
}

#pragma mark - Capability gate

static BOOL SPORequiredBehaviorPresent(SPOCapability cap) {
    switch (cap) {
        case SPOCapabilityVirtualDisplay:
            return objc_getClass("CGVirtualDisplay") != Nil
                && objc_getClass("CGVirtualDisplayDescriptor") != Nil
                && objc_getClass("CGVirtualDisplayMode") != Nil
                && objc_getClass("CGVirtualDisplaySettings") != Nil;
        case SPOCapabilityFocusWithoutRaise:
            // The record layout is not a runtime-discoverable contract. This incompatible path
            // remains removed; direct per-PID delivery does not require it.
            return NO;
        case SPOCapabilitySpaceQuery:
            return p_SLSMainConnectionID != NULL
                && p_SLSCopyManagedDisplaySpaces != NULL
                && p_SLSCopySpacesForWindows != NULL
                && p_SLSGetActiveSpace != NULL
                && p_SLSGetWindowBounds != NULL;
        case SPOCapabilityPerPIDEvents:
            return p_CGEventPostToPid != NULL;
        case SPOCapabilityAXWindowID:
            return p_AXUIElementGetWindow != NULL;
        default:
            return NO;
    }
}

BOOL SPOCapabilityAvailable(SPOCapability cap) {
    SPOLoad();
    return SPORequiredBehaviorPresent(cap);
}

NSString *SPOCapabilityName(SPOCapability cap) {
    switch (cap) {
        case SPOCapabilityVirtualDisplay:    return @"virtual-display";
        case SPOCapabilityFocusWithoutRaise: return @"focus-without-raise";
        case SPOCapabilitySpaceQuery:        return @"space-query";
        case SPOCapabilityPerPIDEvents:      return @"per-pid-events";
        case SPOCapabilityAXWindowID:        return @"ax-window-id";
        default:                             return @"unknown";
    }
}

NSString *_Nullable SPOCapabilityUnavailableReason(SPOCapability cap) {
    SPOLoad();
    if (cap == SPOCapabilityFocusWithoutRaise) {
        return @"the incompatible private focus-record path is not used; "
               @"input falls back to direct per-PID delivery";
    }
    if (!SPORequiredBehaviorPresent(cap)) {
        return [NSString stringWithFormat:
            @"the current macOS runtime is missing a required symbol or Objective-C class for %@",
            SPOCapabilityName(cap)];
    }
    return nil;
}

NSArray<NSString *> *SPOMissingSymbols(void) {
    SPOLoad();
    return [g_missing copy];
}

BOOL SPOBuiltWithARC(void) {
#if __has_feature(objc_arc)
    return YES;
#else
    return NO;
#endif
}

BOOL SPOSetGlobalHotKeysEnabled(BOOL enabled) {
    SPOLoad();
    if (!p_SLSMainConnectionID || !p_CGSSetGlobalHotKeyOperatingMode) return NO;
    // CGSGlobalHotKeyOperatingMode: enable = 0, disable = 1.
    return p_CGSSetGlobalHotKeyOperatingMode(
        p_SLSMainConnectionID(), enabled ? 0 : 1) == kCGErrorSuccess;
}

#pragma mark - Virtual display class surface

@interface CGVirtualDisplayDescriptor : NSObject
@property (nonatomic, assign) unsigned int vendorID, productID, serialNum;
@property (nonatomic, strong) NSString *name;
@property (nonatomic, assign) CGSize sizeInMillimeters;
@property (nonatomic, assign) unsigned int maxPixelsWide, maxPixelsHigh;
@property (nonatomic, assign) CGPoint redPrimary, greenPrimary, bluePrimary, whitePoint;
@property (nonatomic, strong) dispatch_queue_t queue;
@property (nonatomic, copy)   void (^terminationHandler)(id a, id b);
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)w height:(unsigned int)h refreshRate:(double)r;
@end

@interface CGVirtualDisplaySettings : NSObject
@property (nonatomic, strong) NSArray *modes;
@property (nonatomic, assign) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)d;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)s;
@property (nonatomic, readonly) CGDirectDisplayID displayID;
@end

@implementation SPOVirtualDisplay {
    CGVirtualDisplay *_display;      // strong ref *is* the display's lifetime
    dispatch_queue_t _queue;         // must outlive _display
    CGDirectDisplayID _displayID;
    BOOL _settingsApplied;
}

- (nullable instancetype)initWithName:(NSString *)name
                                width:(uint32_t)width
                               height:(uint32_t)height
                                hiDPI:(BOOL)hiDPI {
    return [self initWithName:name width:width height:height hiDPI:hiDPI serial:0];
}

- (nullable instancetype)initWithName:(NSString *)name
                                width:(uint32_t)width
                               height:(uint32_t)height
                                hiDPI:(BOOL)hiDPI
                               serial:(uint32_t)serial {
    self = [super init];
    if (!self) return nil;
    if (!SPOCapabilityAvailable(SPOCapabilityVirtualDisplay)) return nil;
    if (width == 0 || height == 0) return nil;

    Class descClass = objc_getClass("CGVirtualDisplayDescriptor");
    Class modeClass = objc_getClass("CGVirtualDisplayMode");
    Class setClass  = objc_getClass("CGVirtualDisplaySettings");
    Class dispClass = objc_getClass("CGVirtualDisplay");

    CGVirtualDisplayDescriptor *desc = [[descClass alloc] init];
    desc.name              = name;
    desc.vendorID          = 0x1AF2;                 // identifies a SpaceO stage
    desc.productID         = 0x0001;
    // A serial number is a persistent hardware identity to WindowServer and ColorSync, which
    // keep a device registration, a factory profile and display mappings per identity and never
    // remove them. Callers pass an identity from a bounded set (RA-057): a fresh identity per
    // attachment grew ColorSync's registry until every display-info request stalled WindowServer.
    // An identity that macOS restores into a bad saved state (online but inactive, no managed
    // Space) is rejected at publication and rotated by the caller. Zero keeps the historical
    // random identity for package clients that do not choose one.
    desc.serialNum = serial;
    while (desc.serialNum == 0) desc.serialNum = arc4random();
    desc.maxPixelsWide     = width;
    desc.maxPixelsHigh     = height;
    desc.sizeInMillimeters = CGSizeMake(width / 4.0, height / 4.0);   // ~101 dpi
    desc.redPrimary        = CGPointMake(0.6800, 0.3200);
    desc.greenPrimary      = CGPointMake(0.2650, 0.6900);
    desc.bluePrimary       = CGPointMake(0.1500, 0.0600);
    desc.whitePoint        = CGPointMake(0.3127, 0.3290);

    // A private serial queue, NOT the main queue.
    //
    // CoreGraphics publishes the display's lifecycle messages (it is live, here are your
    // bounds, it has been retired) on this queue. Binding it to the main queue makes display
    // creation and teardown silently depend on the *caller* running a main run loop — which
    // an XCTest case or a CLI one-shot does not. Symptom when we got this wrong: the display
    // registered but never reported bounds, and never went away on release.
    _queue = dispatch_queue_create("dev.spaceo.virtual-display", DISPATCH_QUEUE_SERIAL);
    desc.queue = _queue;

    _display = [[dispClass alloc] initWithDescriptor:desc];
    if (!_display) return nil;

    CGVirtualDisplaySettings *settings = [[setClass alloc] init];
    settings.modes = @[ [[modeClass alloc] initWithWidth:width height:height refreshRate:60.0] ];
    settings.hiDPI = hiDPI ? 1 : 0;
    // A refused mode leaves an attached display: keep owning it and report the refusal, so the
    // caller retains it instead of ARC tearing it down as an unplanned graph change.
    _settingsApplied = [_display applySettings:settings];

    _displayID = _display.displayID;
    return self;
}

- (BOOL)settingsApplied        { return _settingsApplied; }
- (CGDirectDisplayID)displayID { return _displayID; }
- (BOOL)valid                  { return _display != nil && _displayID != 0; }
- (CGRect)bounds               { return _displayID ? CGDisplayBounds(_displayID) : CGRectZero; }
- (void)invalidate             { _display = nil; _displayID = 0; _queue = nil; }
- (void)dealloc                { _display = nil; _queue = nil; }

@end

#pragma mark - Space graph

static NSString *_Nullable UUIDStringForDisplay(CGDirectDisplayID did) {
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(did);
    if (!uuid) return nil;
    CFStringRef s = CFUUIDCreateString(kCFAllocatorDefault, uuid);
    NSString *result = (__bridge_transfer NSString *)s;
    CFRelease(uuid);
    return result;
}

NSArray *_Nullable SPOManagedDisplaySpaces(void) {
    SPOLoad();
    if (!SPOCapabilityAvailable(SPOCapabilitySpaceQuery)) return nil;
    if (!p_SLSMainConnectionID || !p_SLSCopyManagedDisplaySpaces) return nil;
    CFArrayRef raw = p_SLSCopyManagedDisplaySpaces(p_SLSMainConnectionID());
    if (!raw) return nil;
    if (CFGetTypeID(raw) != CFArrayGetTypeID()) {
        CFRelease(raw);
        return nil;
    }
    return (__bridge_transfer NSArray *)raw;
}

NSArray<NSNumber *> *_Nullable SPOSpacesForDisplay(CGDirectDisplayID displayID) {
    NSArray *displays = SPOManagedDisplaySpaces();
    if (!displays) return nil;
    // The display's UUID is the only thing we match on.
    //
    // The tempting fallbacks — "there is only one entry, so it must be the one asked for" and
    // "the entry literally named Main" — answer with the *user's* Space list for an agent
    // display id. That answer reaches AgentActivity.claim(spaces:), which is what every
    // isolation verdict is decided against: the user's own active Space gets filed as agent
    // territory and `verify` reports a breach on every run the user caused themselves, while a
    // real Space breach on the agent display is masked behind the same wrong set. With no UUID
    // to match on there is no answer to give, and reporting none lets callers treat the Space
    // set as unknown instead of inheriting a guess.
    NSString *want = UUIDStringForDisplay(displayID);
    if (!want) return nil;
    for (id value in displays) {
        if (![value isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *d = value;
        id rawIdent = d[@"Display Identifier"];
        if (![rawIdent isKindOfClass:NSString.class]) continue;
        if (![(NSString *)rawIdent isEqualToString:want]) continue;
        NSMutableArray<NSNumber *> *out = [NSMutableArray array];
        id rawSpaces = d[@"Spaces"];
        if (![rawSpaces isKindOfClass:NSArray.class]) return out;
        for (id spaceValue in (NSArray *)rawSpaces) {
            if (![spaceValue isKindOfClass:NSDictionary.class]) continue;
            id sid = ((NSDictionary *)spaceValue)[@"ManagedSpaceID"];
            if ([sid isKindOfClass:NSNumber.class]) [out addObject:sid];
        }
        return out;
    }
    return @[];
}

NSArray<NSNumber *> *_Nullable SPOSpacesForWindow(uint32_t windowID) {
    SPOLoad();
    if (!SPOCapabilityAvailable(SPOCapabilitySpaceQuery)) return nil;
    if (!p_SLSMainConnectionID || !p_SLSCopySpacesForWindows) return nil;
    CFArrayRef raw = p_SLSCopySpacesForWindows(p_SLSMainConnectionID(), 0x7,
                                               (__bridge CFArrayRef)@[ @(windowID) ]);
    if (!raw) return nil;
    if (CFGetTypeID(raw) != CFArrayGetTypeID()) {
        CFRelease(raw);
        return nil;
    }
    NSArray *values = (__bridge_transfer NSArray *)raw;
    NSMutableArray<NSNumber *> *out = [NSMutableArray array];
    for (id value in values) {
        if ([value isKindOfClass:NSNumber.class]) [out addObject:value];
    }
    return out;
}

uint64_t SPOActiveSpace(void) {
    SPOLoad();
    if (!SPOCapabilityAvailable(SPOCapabilitySpaceQuery)) return 0;
    if (!p_SLSMainConnectionID || !p_SLSGetActiveSpace) return 0;
    return p_SLSGetActiveSpace(p_SLSMainConnectionID());
}

#pragma mark - Focus routing

SPOFocusResult SPOFocusWithoutRaiseResult(pid_t pid, uint32_t windowID) {
    SPOLoad();
    // Do not rely on Swift callers having checked the capability. This C function is public to
    // the package and validates the runtime symbol at the mutation boundary itself.
    if (!SPOCapabilityAvailable(SPOCapabilityFocusWithoutRaise))
        return SPOFocusResultNotAttempted;
    if (!p_SLPSPostEventRecordTo) return SPOFocusResultNotAttempted;

    ProcessSerialNumber psn = {0, kNoProcess};
    if (GetProcessForPID(pid, &psn) != noErr) return SPOFocusResultNotAttempted;

    // Record 1: "you are now the active app for input routing".
    // Crucially this is NOT SLPSSetFrontProcessWithOptions, so nothing is raised and the
    // user is not dragged to this app's Space.
    uint8_t activate[0xf8] = {0};
    activate[0x04] = 0xf8;
    activate[0x08] = 0x0d;
    memcpy(activate + 0x3c, &windowID, sizeof windowID);
    memset(activate + 0x20, 0xff, 0x10);
    activate[0x8a] = 0x01;
    if (p_SLPSPostEventRecordTo(&psn, activate) != noErr)
        return SPOFocusResultFailedAfterActivationRecord;

    // Record 2 & 3: make that specific window the key window within the app.
    uint8_t key[0xf8] = {0};
    key[0x04] = 0xf8;
    key[0x3a] = 0x10;
    memcpy(key + 0x3c, &windowID, sizeof windowID);
    memset(key + 0x20, 0xff, 0x10);
    key[0x08] = 0x01;
    if (p_SLPSPostEventRecordTo(&psn, key) != noErr)
        return SPOFocusResultFailedAfterKeyDownRecord;
    key[0x08] = 0x02;
    if (p_SLPSPostEventRecordTo(&psn, key) != noErr)
        return SPOFocusResultFailedAfterKeyUpRecord;

    return SPOFocusResultSucceeded;
}

BOOL SPOFocusWithoutRaise(pid_t pid, uint32_t windowID) {
    return SPOFocusWithoutRaiseResult(pid, windowID) == SPOFocusResultSucceeded;
}

pid_t SPOFrontProcessPID(void) {
    // Retained as an ABI-compatible stub for existing package clients. A symbol resolving via
    // dlsym does not prove its private calling convention, and the product has a public AppKit
    // source for the frontmost application. Do not query another guessed ProcessSerialNumber ABI.
    return 0;
}

#pragma mark - Window geometry

BOOL SPOWindowBounds(uint32_t windowID, CGRect *outBounds) {
    SPOLoad();
    if (!SPOCapabilityAvailable(SPOCapabilitySpaceQuery)) return NO;
    if (!p_SLSMainConnectionID || !p_SLSGetWindowBounds || !outBounds) return NO;
    if (p_SLSGetWindowBounds(p_SLSMainConnectionID(), windowID, outBounds)
        != kCGErrorSuccess) return NO;
    return isfinite(outBounds->origin.x) && isfinite(outBounds->origin.y)
        && isfinite(outBounds->size.width) && isfinite(outBounds->size.height)
        && outBounds->size.width >= 0 && outBounds->size.height >= 0;
}

uint32_t SPOWindowIDForAXElement(AXUIElementRef element) {
    uint32_t wid = 0;
    return SPOGetWindowIDForAXElement(element, &wid) == kAXErrorSuccess ? wid : 0;
}

AXError SPOGetWindowIDForAXElement(AXUIElementRef element, uint32_t *outWindowID) {
    if (outWindowID) *outWindowID = 0;
    if (!element || !outWindowID) return kAXErrorIllegalArgument;
    SPOLoad();
    if (!SPOCapabilityAvailable(SPOCapabilityAXWindowID) || !p_AXUIElementGetWindow) {
        return kAXErrorNotImplemented;
    }
    uint32_t wid = 0;
    AXError status = p_AXUIElementGetWindow(element, &wid);
    if (status == kAXErrorSuccess) *outWindowID = wid;
    return status;
}

#pragma mark - Per-process event delivery

BOOL SPOPostEventToPID(pid_t pid, CGEventRef event) {
    SPOLoad();
    if (!event || pid <= 0) return NO;
    if (!SPOCapabilityAvailable(SPOCapabilityPerPIDEvents)) return NO;
    if (!p_CGEventPostToPid) return NO;
    p_CGEventPostToPid(pid, event);
    return YES;
}
