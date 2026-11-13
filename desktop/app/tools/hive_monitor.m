// Hive's virtual monitor: one extra display that macOS treats as a real second screen.
//
// Because it is an ordinary display, the one real cursor can move onto it, a click there gives
// that window the real keyboard focus, and every native control (AutoFill menus, password
// prompts, file pickers) works exactly as it does on the built-in screen. Nothing here forwards
// or fakes input.
//
//   hive-monitor serve [WIDTHxHEIGHT]   create the display and keep it until this process ends
//   hive-monitor info                   print the display's id and bounds as JSON (exit 1 if off)
//   hive-monitor place PID              move that app's front window onto the display
//   hive-monitor switch                 stay running: a tap of right Option shows the display on your
//                                       screen with your cursor and keyboard on it; tap again to come back
//   hive-monitor selftest               check the right Option tap rules
//
// The display-creation calls follow the approach of the SpaceO engine this replaces
// (CoreGraphics' CGVirtualDisplay classes, looked up at run time, on a private queue).
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreMedia/CoreMedia.h>
#import <QuartzCore/QuartzCore.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <objc/runtime.h>
#include <fcntl.h>
#include <sys/file.h>

static const uint32_t kHiveVendor = 0x4856;   // "HV"
static const uint32_t kHiveProduct = 0x0001;
// One fixed identity: WindowServer and ColorSync keep a registration per serial number forever,
// so a new serial per launch would grow those registries without bound.
static const uint32_t kHiveSerial = 0x48495645;  // "HIVE"

@interface CGVirtualDisplayDescriptor : NSObject
@property (nonatomic, assign) unsigned int vendorID, productID, serialNum;
@property (nonatomic, strong) NSString *name;
@property (nonatomic, assign) CGSize sizeInMillimeters;
@property (nonatomic, assign) unsigned int maxPixelsWide, maxPixelsHigh;
@property (nonatomic, assign) CGPoint redPrimary, greenPrimary, bluePrimary, whitePoint;
@property (nonatomic, strong) dispatch_queue_t queue;
@property (nonatomic, copy) void (^terminationHandler)(id a, id b);
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

static CGDirectDisplayID onlineHiveDisplay(void) {
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(0, NULL, &count) != kCGErrorSuccess || count == 0) return 0;
    CGDirectDisplayID ids[32];
    if (count > 32) count = 32;
    if (CGGetOnlineDisplayList(count, ids, &count) != kCGErrorSuccess) return 0;
    for (uint32_t i = 0; i < count; i++) {
        if (CGDisplayVendorNumber(ids[i]) == kHiveVendor && CGDisplayModelNumber(ids[i]) == kHiveProduct) return ids[i];
    }
    return 0;
}

static void printInfo(CGDirectDisplayID display, const char *state) {
    CGRect b = CGDisplayBounds(display);
    printf("{\"state\": \"%s\", \"displayID\": %u, \"bounds\": [%.0f, %.0f, %.0f, %.0f], \"pid\": %d}\n",
           state, display, b.origin.x, b.origin.y, b.size.width, b.size.height, getpid());
    fflush(stdout);
}

static int serve(uint32_t width, uint32_t height) {
    CGDirectDisplayID existing = onlineHiveDisplay();
    if (existing) { printInfo(existing, "already-on"); return 0; }

    Class descClass = objc_getClass("CGVirtualDisplayDescriptor");
    Class modeClass = objc_getClass("CGVirtualDisplayMode");
    Class setClass = objc_getClass("CGVirtualDisplaySettings");
    Class dispClass = objc_getClass("CGVirtualDisplay");
    if (!descClass || !modeClass || !setClass || !dispClass) {
        fprintf(stderr, "This macOS does not offer virtual displays.\n");
        return 2;
    }
    CGVirtualDisplayDescriptor *desc = [[descClass alloc] init];
    desc.name = @"Hive Monitor";
    desc.vendorID = kHiveVendor;
    desc.productID = kHiveProduct;
    desc.serialNum = kHiveSerial;
    desc.maxPixelsWide = width * 2;   // Retina backing, so small text stays readable in screenshots
    desc.maxPixelsHigh = height * 2;
    desc.sizeInMillimeters = CGSizeMake(width / 4.0, height / 4.0);
    desc.redPrimary = CGPointMake(0.6800, 0.3200);
    desc.greenPrimary = CGPointMake(0.2650, 0.6900);
    desc.bluePrimary = CGPointMake(0.1500, 0.0600);
    desc.whitePoint = CGPointMake(0.3127, 0.3290);
    // CoreGraphics reports the display's life on this queue; it must not be the main queue.
    static dispatch_queue_t queue;
    queue = dispatch_queue_create("hive.virtual-monitor", DISPATCH_QUEUE_SERIAL);
    desc.queue = queue;

    static CGVirtualDisplay *display;  // this strong reference is the display's lifetime
    display = [[dispClass alloc] initWithDescriptor:desc];
    if (!display) { fprintf(stderr, "macOS refused to create the display.\n"); return 3; }
    CGVirtualDisplaySettings *settings = [[setClass alloc] init];
    settings.modes = @[ [[modeClass alloc] initWithWidth:width height:height refreshRate:60.0] ];
    settings.hiDPI = 1;
    if (![display applySettings:settings]) {
        settings.hiDPI = 0;
        if (![display applySettings:settings]) { fprintf(stderr, "macOS refused the display mode.\n"); return 4; }
    }
    CGDirectDisplayID displayID = display.displayID;
    for (int i = 0; i < 100 && CGRectIsEmpty(CGDisplayBounds(displayID)); i++) usleep(50 * 1000);
    if (CGRectIsEmpty(CGDisplayBounds(displayID))) { fprintf(stderr, "The display never came online.\n"); return 5; }
    printInfo(displayID, "on");

    // The display goes away when this process ends, however it ends.
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    dispatch_main();
    return 0;
}

static int place(pid_t pid) {
    CGDirectDisplayID display = onlineHiveDisplay();
    if (!display) { fprintf(stderr, "Hive's virtual monitor is off.\n"); return 1; }
    if (!AXIsProcessTrusted()) { fprintf(stderr, "Accessibility permission is needed to move a window.\n"); return 2; }
    CGRect area = CGDisplayBounds(display);
    for (NSScreen *screen in NSScreen.screens) {
        NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
        if (number.unsignedIntValue != display) continue;
        // Cocoa measures from the bottom of the primary screen; Accessibility from its top.
        CGFloat primaryHeight = NSScreen.screens.firstObject.frame.size.height;
        NSRect visible = screen.visibleFrame;
        area = CGRectMake(visible.origin.x, primaryHeight - (visible.origin.y + visible.size.height),
                          visible.size.width, visible.size.height);
    }
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXUIElementRef window = NULL;
    for (int attempt = 0; attempt < 40 && !window; attempt++) {  // a just-opened app has no window yet
        CFTypeRef value = NULL;
        if ((AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &value) == kAXErrorSuccess ||
             AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute, &value) == kAXErrorSuccess) && value) {
            window = (AXUIElementRef)value;
            break;
        }
        CFTypeRef windows = NULL;
        if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &windows) == kAXErrorSuccess && windows) {
            if (CFArrayGetCount(windows) > 0) window = (AXUIElementRef)CFRetain(CFArrayGetValueAtIndex(windows, 0));
            CFRelease(windows);
        }
        if (!window) usleep(250 * 1000);
    }
    if (!window) { CFRelease(app); fprintf(stderr, "That app has no window to move.\n"); return 3; }
    CGPoint origin = area.origin;
    CGSize size = area.size;
    AXValueRef position = AXValueCreate(kAXValueCGPointType, &origin);
    AXValueRef extent = AXValueCreate(kAXValueCGSizeType, &size);
    // Move, size, then move again: a window wider than its old screen is first clipped by macOS.
    AXError moved = AXUIElementSetAttributeValue(window, kAXPositionAttribute, position);
    AXUIElementSetAttributeValue(window, kAXSizeAttribute, extent);
    AXUIElementSetAttributeValue(window, kAXPositionAttribute, position);
    AXUIElementPerformAction(window, kAXRaiseAction);
    CFRelease(position); CFRelease(extent); CFRelease(window); CFRelease(app);
    if (moved != kAXErrorSuccess) { fprintf(stderr, "macOS would not move that window (%d).\n", (int)moved); return 4; }
    printf("moved\n");
    return 0;
}

// ---- switch: tap right Option to look at the virtual monitor --------------------------------
//
// `hive-monitor switch` runs beside `serve`, as a process of its own, so nothing that happens to
// it can take the display (and the windows on it) away. A tap of right Option on its own covers
// the screen you're using with the virtual monitor, live, and puts your cursor and keyboard on
// it: the window only shows the picture and lets every click through, and the real cursor is on
// the virtual monitor, so what you click and type lands there exactly as on a second screen. A
// second tap brings you back: the cursor returns where it was and the app you were using comes
// forward again. Nothing is forwarded or faked, as with the display itself.

static const unsigned short kRightOptionKey = 61;  // kVK_RightOption
static const NSEventModifierFlags kRightOptionDown = 0x40;  // NX_DEVICERALTKEYMASK: right Option, not left
static const double kTapSeconds = 0.7;

typedef struct { double started; BOOL down; BOOL used; } OptionTap;

/// One event into the tap detector. YES when right Option went down and came up on its own within
/// 0.7 s: held longer, or pressed with a key, a click, a scroll or another modifier, it isn't a tap.
static BOOL optionTapObserve(OptionTap *tap, NSEventType type, unsigned short code, NSEventModifierFlags flags, double now) {
    if (type == NSEventTypeFlagsChanged && code == kRightOptionKey) {
        BOOL down = (flags & kRightOptionDown) != 0;
        if (down && !tap->down) {
            tap->down = YES;
            tap->started = now;
            tap->used = (flags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagShift |
                                  NSEventModifierFlagFunction)) != 0;
        } else if (!down && tap->down) {
            tap->down = NO;
            return !tap->used && now - tap->started < kTapSeconds;
        }
    } else if (tap->down && type != NSEventTypeMouseMoved) {
        tap->used = YES;
    }
    return NO;
}

/// The nearest point of `area` (global, top-left coordinates) to `point`.
static CGPoint clampInto(CGPoint point, CGRect area) {
    return CGPointMake(fmin(fmax(point.x, CGRectGetMinX(area)), CGRectGetMaxX(area) - 1),
                       fmin(fmax(point.y, CGRectGetMinY(area)), CGRectGetMaxY(area) - 1));
}

static CGPoint cursorNow(void) {
    CGEventRef event = CGEventCreate(NULL);
    CGPoint point = event ? CGEventGetLocation(event) : CGPointZero;
    if (event) CFRelease(event);
    return point;
}

static void moveCursor(CGPoint point) {
    CGWarpMouseCursorPosition(point);
    CGAssociateMouseAndMouseCursorPosition(true);  // no pause in mouse movement after the jump
}

/// The app that owns the frontmost ordinary window on `area`, or 0.
static pid_t frontOwnerOn(CGRect area) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    pid_t owner = 0;
    for (NSDictionary *window in (__bridge NSArray *)list) {  // front to back
        if ([window[(id)kCGWindowLayer] intValue] != 0) continue;
        CGRect bounds;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) continue;
        if (bounds.size.width < 50 || bounds.size.height < 50 || !CGRectIntersectsRect(bounds, area)) continue;
        owner = [window[(id)kCGWindowOwnerPID] intValue];
        break;
    }
    if (list) CFRelease(list);
    return owner;
}

/// Brings an app forward (its keyboard focus with it) through Accessibility.
static void bringForward(pid_t pid) {
    if (pid <= 0 || pid == getpid()) return;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);
    CFRelease(app);
}

static NSString *stateDir(void) {
    const char *dir = getenv("AGENT_STATE_DIR");
    if (dir && *dir) return @(dir);
    return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Personal Agent"];
}

@interface HiveSwitch : NSObject <SCStreamOutput, SCStreamDelegate>
- (void)switchOut;
- (void)toggle;
@end

@implementation HiveSwitch {
    OptionTap _tap;
    BOOL _showing;
    NSUInteger _generation;   // which switch-in a capture callback belongs to
    NSWindow *_window;
    CALayer *_picture;
    CATextLayer *_hint;
    SCStream *_stream;
    dispatch_queue_t _frames;
    CGDirectDisplayID _display;
    CGRect _area;             // the virtual monitor, in global top-left coordinates
    CGPoint _returnTo;        // your cursor before switching in
    CGPoint _lastThere;       // your cursor on the virtual monitor when you last switched out
    BOOL _hasLastThere;
    pid_t _previous;          // the app you were using
    BOOL _pictured;           // the first frame of this switch-in arrived
    id _monitor;
}

- (instancetype)init {
    if (!(self = [super init])) return nil;
    _frames = dispatch_queue_create("hive.monitor-switch.frames", DISPATCH_QUEUE_SERIAL);
    NSEventMask mask = NSEventMaskFlagsChanged | NSEventMaskKeyDown | NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown |
                       NSEventMaskOtherMouseDown | NSEventMaskScrollWheel | NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged |
                       NSEventMaskRightMouseDragged | NSEventMaskOtherMouseDragged;
    __weak HiveSwitch *weakSelf = self;
    _monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event) { [weakSelf handle:event]; }];
    return self;
}

- (void)handle:(NSEvent *)event {
    NSEventType type = event.type;
    unsigned short code = (type == NSEventTypeFlagsChanged || type == NSEventTypeKeyDown) ? event.keyCode : 0;
    if (optionTapObserve(&_tap, type, code, event.modifierFlags, NSProcessInfo.processInfo.systemUptime)) {
        fprintf(stderr, "switch: right Option tapped\n");
        [self toggle];
        return;
    }
    if (_showing && (type == NSEventTypeMouseMoved || type == NSEventTypeLeftMouseDragged ||
                     type == NSEventTypeRightMouseDragged || type == NSEventTypeOtherMouseDragged)) {
        // The virtual monitor sits beside your screen in the arrangement; while you're on it, the
        // cursor stays on it instead of wandering under the picture onto your own screen.
        CGRect area = CGDisplayBounds(_display);
        if (CGRectIsEmpty(area)) { [self switchOut]; return; }
        _area = area;
        CGPoint here = cursorNow();
        if (!CGRectContainsPoint(area, here)) moveCursor(clampInto(here, area));
    }
}

- (void)toggle {
    if (_showing) [self switchOut]; else [self switchIn];
}

/// The screen you're using: the one under the cursor, else the first that isn't the virtual monitor.
- (NSScreen *)yourScreen {
    NSPoint mouse = NSEvent.mouseLocation;
    NSScreen *fallback = nil;
    for (NSScreen *screen in NSScreen.screens) {
        if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == _display) continue;
        if (!fallback) fallback = screen;
        if (NSMouseInRect(mouse, screen.frame, NO)) return screen;
    }
    return fallback;
}

- (void)switchIn {
    CGDirectDisplayID display = onlineHiveDisplay();
    if (!display) { fprintf(stderr, "switch: the virtual monitor is off\n"); NSBeep(); return; }
    if (!CGPreflightScreenCaptureAccess()) {
        fprintf(stderr, "switch: no Screen Recording permission, so the virtual monitor can't be shown\n");
        NSBeep();
        return;
    }
    _display = display;
    _area = CGDisplayBounds(display);
    NSScreen *screen = [self yourScreen];
    if (!screen) { fprintf(stderr, "switch: no screen of yours to show it on\n"); return; }
    CGPoint here = cursorNow();
    if (CGRectContainsPoint(_area, here)) {  // the agent left the cursor there: come back to your screen's middle
        CGFloat primaryHeight = NSScreen.screens.firstObject.frame.size.height;
        here = CGPointMake(NSMidX(screen.frame), primaryHeight - NSMidY(screen.frame));
    }
    _returnTo = here;
    _previous = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    _showing = YES;
    _pictured = NO;
    [self showOn:screen];
    [self capture];
    moveCursor(_hasLastThere && CGRectContainsPoint(_area, _lastThere) ? _lastThere
                                                                         : CGPointMake(CGRectGetMidX(_area), CGRectGetMidY(_area)));
    bringForward(frontOwnerOn(_area));
    fprintf(stderr, "switch: on the virtual monitor\n");
}

- (void)switchOut {
    if (!_showing) return;
    _showing = NO;
    _generation++;
    SCStream *stream = _stream;
    _stream = nil;
    [stream stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; }];
    [_window orderOut:nil];
    _picture.contents = nil;
    CGPoint here = cursorNow();
    if (CGRectContainsPoint(_area, here)) { _lastThere = here; _hasLastThere = YES; }
    moveCursor(_returnTo);
    bringForward(_previous);
    fprintf(stderr, "switch: back on your screen\n");
}

- (void)showOn:(NSScreen *)screen {
    if (!_window) {
        _window = [[NSWindow alloc] initWithContentRect:screen.frame styleMask:NSWindowStyleMaskBorderless
                                                backing:NSBackingStoreBuffered defer:NO];
        _window.releasedWhenClosed = NO;
        _window.opaque = YES;
        _window.hasShadow = NO;
        _window.backgroundColor = NSColor.blackColor;
        _window.ignoresMouseEvents = YES;          // clicks go to where the cursor really is: the virtual monitor
        _window.level = NSScreenSaverWindowLevel;  // over the menu bar and the Dock too
        _window.sharingType = NSWindowSharingNone; // never in a screenshot or recording of your screen
        _window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary |
                                     NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle;
        NSView *view = _window.contentView;
        view.wantsLayer = YES;
        _picture = [CALayer layer];
        _picture.contentsGravity = kCAGravityResizeAspect;
        _picture.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
        _picture.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
        _picture.frame = view.layer.bounds;
        [view.layer addSublayer:_picture];
        _hint = [CATextLayer layer];
        _hint.string = @"Hive's virtual monitor  ·  tap right Option to go back";
        _hint.font = (__bridge CFTypeRef)[NSFont systemFontOfSize:15 weight:NSFontWeightSemibold];
        _hint.fontSize = 15;
        _hint.alignmentMode = kCAAlignmentCenter;
        _hint.foregroundColor = CGColorGetConstantColor(kCGColorWhite);
        _hint.backgroundColor = [NSColor colorWithWhite:0 alpha:0.72].CGColor;
        _hint.cornerRadius = 10;
        [view.layer addSublayer:_hint];
    }
    [_window setFrame:screen.frame display:NO];
    _picture.frame = _window.contentView.layer.bounds;
    _picture.contents = nil;
    CGFloat scale = screen.backingScaleFactor;
    _hint.contentsScale = scale;
    NSRect bounds = _window.contentView.bounds;
    _hint.frame = CGRectMake(NSMidX(bounds) - 230, NSMaxY(bounds) - 64, 460, 34);
    [_hint removeAllAnimations];
    _hint.opacity = 1;
    [_window orderFrontRegardless];
    NSUInteger generation = _generation;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self->_generation == generation && self->_showing) {
            [CATransaction begin];
            [CATransaction setAnimationDuration:0.6];
            self->_hint.opacity = 0;
            [CATransaction commit];
        }
    });
}

/// Streams the virtual monitor into the picture, cursor included, until switching out.
- (void)capture {
    NSUInteger generation = _generation;
    CGDirectDisplayID display = _display;
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
                                                 completionHandler:^(SCShareableContent *content, NSError *error) {
        SCDisplay *target = nil;
        for (SCDisplay *candidate in content.displays) if (candidate.displayID == display) target = candidate;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self->_generation != generation || !self->_showing) return;
            if (!target) {
                fprintf(stderr, "switch: can't capture the virtual monitor (%s)\n", error ? error.localizedDescription.UTF8String : "not listed");
                [self switchOut];
                return;
            }
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:target excludingWindows:@[]];
            SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
            CGFloat scale = filter.pointPixelScale > 0 ? filter.pointPixelScale : 2;
            config.width = (size_t)(target.width * scale);
            config.height = (size_t)(target.height * scale);
            config.showsCursor = YES;
            config.minimumFrameInterval = CMTimeMake(1, 60);
            config.queueDepth = 5;
            config.pixelFormat = 'BGRA';
            SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self];
            NSError *added = nil;
            if (![stream addStreamOutput:self type:SCStreamOutputTypeScreen sampleHandlerQueue:self->_frames error:&added]) {
                fprintf(stderr, "switch: can't capture the virtual monitor (%s)\n", added.localizedDescription.UTF8String);
                [self switchOut];
                return;
            }
            self->_stream = stream;
            [stream startCaptureWithCompletionHandler:^(NSError *failed) {
                if (!failed) return;
                dispatch_async(dispatch_get_main_queue(), ^{
                    fprintf(stderr, "switch: capture didn't start (%s)\n", failed.localizedDescription.UTF8String);
                    if (self->_stream == stream) [self switchOut];
                });
            }];
        });
    }];
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)buffer ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(buffer)) return;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, false);
    if (!attachments || CFArrayGetCount(attachments) == 0) return;
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    if ([info[SCStreamFrameInfoStatus] integerValue] != SCFrameStatusComplete) return;  // idle frames carry no picture
    CVImageBufferRef image = CMSampleBufferGetImageBuffer(buffer);
    IOSurfaceRef surface = image ? CVPixelBufferGetIOSurface(image) : NULL;
    if (!surface) return;
    id picture = (__bridge id)surface;  // the block keeps it alive until the layer holds it
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_stream != stream) return;
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        self->_picture.contents = picture;
        [CATransaction commit];
        if (!self->_pictured) {
            self->_pictured = YES;
            fprintf(stderr, "switch: showing the virtual monitor (%zux%zu)\n", IOSurfaceGetWidth((__bridge IOSurfaceRef)picture),
                    IOSurfaceGetHeight((__bridge IOSurfaceRef)picture));
        }
    });
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_stream != stream) return;
        fprintf(stderr, "switch: capture stopped (%s)\n", error.localizedDescription.UTF8String);
        [self switchOut];
    });
}
@end

static int runSwitch(void) {
    // One at a time: two would each take the same tap and cancel each other out.
    NSString *dir = stateDir();
    [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES
                                             attributes:@{NSFilePosixPermissions: @0700} error:nil];
    int lock = open([dir stringByAppendingPathComponent:@"monitor-switch.lock"].fileSystemRepresentation, O_RDWR | O_CREAT, 0600);
    if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) { fprintf(stderr, "switch: already running\n"); return 0; }
    if (!AXIsProcessTrusted()) {
        fprintf(stderr, "switch: needs Accessibility permission to see right Option and move the cursor\n");
        return 2;
    }
    if (!CGPreflightScreenCaptureAccess()) fprintf(stderr, "switch: no Screen Recording permission yet; a tap will only beep\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];  // no Dock icon, never takes focus
    static HiveSwitch *hiveSwitch;
    hiveSwitch = [[HiveSwitch alloc] init];
    // Stopped (the virtual monitor turned off, the app quitting): put your cursor back first.
    static dispatch_source_t term, interrupt, flip;
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    signal(SIGUSR1, SIG_IGN);
    // SIGUSR1 is the same as a tap, for a menu item or a check that can't press the key.
    flip = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR1, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(flip, ^{ [hiveSwitch toggle]; });
    dispatch_resume(flip);
    term = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    interrupt = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
    dispatch_block_t stop = ^{ [hiveSwitch switchOut]; exit(0); };
    dispatch_source_set_event_handler(term, stop);
    dispatch_source_set_event_handler(interrupt, stop);
    dispatch_resume(term);
    dispatch_resume(interrupt);
    fprintf(stderr, "switch: ready; tap right Option to see the virtual monitor\n");
    [NSApp run];
    return 0;
}

static int selftest(void) {
    int failed = 0;
#define CHECK(cond, what) do { if (!(cond)) { fprintf(stderr, "FAIL: %s\n", what); failed++; } } while (0)
    const NSEventType flags = NSEventTypeFlagsChanged;
    const NSEventModifierFlags option = NSEventModifierFlagOption;
    OptionTap tap = {0};
    CHECK(!optionTapObserve(&tap, flags, 61, option | 0x40, 10.0), "right Option down is not yet a tap");
    CHECK(optionTapObserve(&tap, flags, 61, 0, 10.1), "a quick press and release of right Option is a tap");
    tap = (OptionTap){0};
    optionTapObserve(&tap, flags, 61, option | 0x40, 10.0);
    CHECK(!optionTapObserve(&tap, NSEventTypeKeyDown, 0, option | 0x40, 10.1), "a key with right Option");
    CHECK(!optionTapObserve(&tap, flags, 61, 0, 10.2), "right Option used with a key is not a tap");
    tap = (OptionTap){0};
    optionTapObserve(&tap, flags, 61, option | 0x40, 20.0);
    CHECK(!optionTapObserve(&tap, flags, 61, 0, 21.0), "holding right Option for a second is not a tap");
    tap = (OptionTap){0};
    optionTapObserve(&tap, flags, 61, option | 0x40 | 0x80000, 30.0);
    optionTapObserve(&tap, NSEventTypeMouseMoved, 0, option | 0x40, 30.05);
    CHECK(optionTapObserve(&tap, flags, 61, 0, 30.1), "moving the mouse during the tap doesn't cancel it");
    tap = (OptionTap){0};
    optionTapObserve(&tap, flags, 61, option | 0x40, 40.0);
    optionTapObserve(&tap, NSEventTypeLeftMouseDown, 0, option | 0x40, 40.05);
    CHECK(!optionTapObserve(&tap, flags, 61, 0, 40.1), "option-click is not a tap");
    tap = (OptionTap){0};
    CHECK(!optionTapObserve(&tap, flags, 61, option | NSEventModifierFlagShift | 0x40, 50.0), "shift + right Option down");
    CHECK(!optionTapObserve(&tap, flags, 61, NSEventModifierFlagShift, 50.1), "shift + right Option is not a tap");
    tap = (OptionTap){0};
    CHECK(!optionTapObserve(&tap, flags, 58, option | 0x20, 60.0), "left Option down");
    CHECK(!optionTapObserve(&tap, flags, 58, 0, 60.1), "left Option is not the switch");
    tap = (OptionTap){0};
    optionTapObserve(&tap, flags, 61, option | 0x40, 70.0);
    optionTapObserve(&tap, flags, 58, option | 0x40 | 0x20, 70.05);
    CHECK(!optionTapObserve(&tap, flags, 61, option | 0x20, 70.1), "both Options together is not a tap");
    CGRect area = CGRectMake(1470, 0, 1440, 900);
    CGPoint inside = clampInto(CGPointMake(2000, 400), area);
    CHECK(inside.x == 2000 && inside.y == 400, "a point on the monitor stays put");
    CGPoint left = clampInto(CGPointMake(1400, 950), area);
    CHECK(left.x == 1470 && left.y == 899, "a point off the monitor comes to its nearest edge");
#undef CHECK
    if (!failed) printf("ok\n");
    return failed ? 1 : 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *command = argc > 1 ? @(argv[1]) : @"";
        if ([command isEqualToString:@"info"]) {
            CGDirectDisplayID display = onlineHiveDisplay();
            if (!display) { fprintf(stderr, "off\n"); return 1; }
            printInfo(display, "on");
            return 0;
        }
        if ([command isEqualToString:@"serve"]) {
            unsigned int width = 1440, height = 900;
            if (argc > 2 && sscanf(argv[2], "%ux%u", &width, &height) != 2) { fprintf(stderr, "Size must look like 1440x900.\n"); return 64; }
            if (width < 800 || height < 600 || width > 3840 || height > 2160) { fprintf(stderr, "Size out of range.\n"); return 64; }
            return serve(width, height);
        }
        if ([command isEqualToString:@"place"] && argc > 2) {
            [NSApplication sharedApplication];  // NSScreen needs a connection to the window server
            return place((pid_t)atoi(argv[2]));
        }
        if ([command isEqualToString:@"switch"]) return runSwitch();
        if ([command isEqualToString:@"selftest"]) return selftest();
        fprintf(stderr, "usage: hive-monitor serve [WIDTHxHEIGHT] | info | place PID | switch | selftest\n");
        return 64;
    }
}
