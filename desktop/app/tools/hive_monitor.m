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
//                                       screen with your cursor and keyboard on it; tap again to come back.
//                                       It also shares the mouse and keyboard while Hive works there
//                                       (monitor-share.sock in the state folder; see "share" below)
//   hive-monitor selftest               check the right Option tap rules
//
// The display is made with CoreGraphics' CGVirtualDisplay classes, looked up at run time, on a
// private queue.
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreMedia/CoreMedia.h>
#import <QuartzCore/QuartzCore.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <IOKit/hidsystem/IOHIDEventSystemClient.h>
#import <IOKit/hidsystem/IOHIDServiceClient.h>
#import <objc/runtime.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>

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

/// The picture's window is on every Space and stays put through Mission Control. Never
/// full-screen auxiliary: with that, Mission Control's opening and closing animation shrinks the
/// picture like an ordinary window (recorded 2026-11-13; ignore-cycle is left out with it).
/// Even so, Mission Control's first and last fifth of a second shrinks the whole Space, picture
/// included, into its Spaces bar, at any window level (recorded at 60 fps, up to the shielding
/// level). So while you're switched in, the apps whose windows are only on your screen are hidden
/// (`hideYourWindows`), and those moments show your wallpaper, not your windows.
static const NSWindowCollectionBehavior kPictureSpaces =
    NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary;

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

/// The apps that own an ordinary window on `area` (global, top-left coordinates).
static NSMutableSet<NSNumber *> *ownersOn(CGRect area) {
    NSMutableSet<NSNumber *> *owners = [NSMutableSet set];
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    for (NSDictionary *window in (__bridge NSArray *)list) {
        if ([window[(id)kCGWindowLayer] intValue] != 0) continue;
        CGRect bounds;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) continue;
        if (bounds.size.width < 50 || bounds.size.height < 50 || !CGRectIntersectsRect(bounds, area)) continue;
        [owners addObject:window[(id)kCGWindowOwnerPID]];
    }
    if (list) CFRelease(list);
    return owners;
}

/// Hides or shows an app through Accessibility (an app's own `hide` refuses a background helper).
static BOOL setAppHidden(pid_t pid, BOOL hidden) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXError error = AXUIElementSetAttributeValue(app, kAXHiddenAttribute, hidden ? kCFBooleanTrue : kCFBooleanFalse);
    CFRelease(app);
    return error == kAXErrorSuccess;
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

/// The beep for a tap that can't switch, unless Hive's sound is off (Agent menu › Sound (Voice and
/// Chimes): "off" in the state folder's speak-aloud).
static void beepUnlessMuted(void) {
    NSString *word = [NSString stringWithContentsOfFile:[stateDir() stringByAppendingPathComponent:@"speak-aloud"]
                                               encoding:NSUTF8StringEncoding error:nil];
    word = [word stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (![word isEqualToString:@"off"]) NSBeep();
}


// ---- share: Hive works on the virtual monitor while you go on working on your screen -----------
//
// While Hive holds the mouse and keyboard there (`hold` on monitor-share.sock, from Hive before
// each step), the real cursor stays on Hive's work and your input becomes a cursor of your own:
//   - your mouse moves a drawn cursor on your screens; the real one, which macOS has already moved
//     by the time anything hears of it, goes straight back to Hive's spot;
//   - a click of yours is a real click at your drawn cursor: the real one comes over for it and
//     goes back a moment later, and Hive's app comes forward again;
//   - your keys go to your app (the one you last clicked) without bringing it forward, and your
//     scrolling to the window under your drawn cursor;
//   - Hive's own input (Karabiner's virtual keyboard and mouse) passes as it is.
// Not shared: system shortcuts and trackpad gestures (dropped: they'd act on Hive's app), a menu
// you open with a click (it follows the real cursor), and Secure Input (a password field in front
// takes the real keyboard, so the input helper is told to let your hands stop Hive meanwhile).
// A tap of right Option still shows the virtual monitor; while it's shown sharing pauses, and the
// input helper hears your hands again (`share off`) and stops Hive, as it did before sharing.
//
//   hold [PID]   start, or go on (PID: Hive's app on the monitor): "ok holding", or "err WHY"
//   release      stop: the real cursor comes back to your drawn one, and your app forward
//   status       ok holding=0|1 showing=0|1

typedef struct __IOHIDEvent *IOHIDEventRef;
extern IOHIDEventRef CGEventCopyIOHIDEvent(CGEventRef event);
extern uint64_t IOHIDEventGetSenderID(IOHIDEventRef event);
extern void CGEventSetWindowLocation(CGEventRef event, CGPoint point);
extern Boolean IsSecureEventInputEnabled(void);

static const CGEventField kTargetWindowField = (CGEventField)51;  // the window a posted mouse event is for
static const double kShareQuietSeconds = 30;   // no word or input from Hive this long: it's gone, let go
static const double kClickSeconds = 0.35;      // the real cursor stays yours this long after a click

typedef enum { FromElsewhere, FromHive, FromYou } InputFrom;

/// The registry ids of Karabiner's virtual keyboard and mouse, which Hive's input helper types and
/// moves with. Every other device is you.
static NSSet<NSNumber *> *hiveDevices(void) {
    NSMutableSet<NSNumber *> *ids = [NSMutableSet set];
    IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreateSimpleClient(kCFAllocatorDefault);
    if (!client) return ids;
    NSArray *services = CFBridgingRelease(IOHIDEventSystemClientCopyServices(client));
    for (id item in services) {
        IOHIDServiceClientRef service = (__bridge IOHIDServiceClientRef)item;
        NSString *product = CFBridgingRelease(IOHIDServiceClientCopyProperty(service, CFSTR("Product")));
        if (![product isKindOfClass:NSString.class] || ![product containsString:@"Karabiner"]) continue;
        NSNumber *registryID = (__bridge NSNumber *)IOHIDServiceClientGetRegistryID(service);
        if ([registryID isKindOfClass:NSNumber.class]) [ids addObject:@(registryID.unsignedLongLongValue)];
    }
    CFRelease(client);
    return ids;
}

/// Who an event came from, by the device that sent it (`sender`). Drags carry no device: they're
/// whoever's button is down. Anything else without one (posted by an app) is left alone.
static InputFrom inputFrom(uint64_t sender, CGEventType type, BOOL yourButtonDown, NSSet<NSNumber *> *hive) {
    if (sender == 0) {
        BOOL drag = type == kCGEventLeftMouseDragged || type == kCGEventRightMouseDragged || type == kCGEventOtherMouseDragged;
        if (!drag) return FromElsewhere;
        return yourButtonDown ? FromYou : FromHive;
    }
    return [hive containsObject:@(sender)] ? FromHive : FromYou;
}

/// The nearest point to `point` on any of `rects` (your screens).
static CGPoint nearestOn(CGPoint point, const CGRect *rects, int count) {
    CGPoint best = point;
    double bestDistance = INFINITY;
    for (int i = 0; i < count; i++) {
        CGPoint candidate = clampInto(point, rects[i]);
        double distance = hypot(candidate.x - point.x, candidate.y - point.y);
        if (distance < bestDistance) { bestDistance = distance; best = candidate; }
    }
    return best;
}

/// Where Hive's cursor is after a move of Hive's of `step` that the event says ended at `at`:
/// there, unless a move of yours knocked the real cursor off Hive's spot just before (then the
/// event is off by your move, and Hive's step counts from its own spot). Never off the monitor.
static CGPoint hiveSpotAfterMove(CGPoint spot, CGPoint at, CGPoint step, CGRect monitor) {
    CGPoint stepped = clampInto(CGPointMake(spot.x + step.x, spot.y + step.y), monitor);
    if (fabs(at.x - stepped.x) <= 1.5 && fabs(at.y - stepped.y) <= 1.5 && CGRectContainsPoint(monitor, at)) return at;
    return stepped;
}

static BOOL samePoint(CGPoint a, CGPoint b) {
    return fabs(a.x - b.x) < 0.5 && fabs(a.y - b.y) < 0.5;
}

/// The frontmost ordinary window under `point` (not ours), its owner and bounds; 0 if none.
static CGWindowID windowAt(CGPoint point, pid_t *owner, CGRect *bounds) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    CGWindowID found = 0;
    for (NSDictionary *window in (__bridge NSArray *)list) {  // front to back
        int layer = [window[(id)kCGWindowLayer] intValue];
        pid_t pid = [window[(id)kCGWindowOwnerPID] intValue];
        if (pid == getpid() || layer < 0 || layer >= kCGMainMenuWindowLevel) continue;
        if ([window[(id)kCGWindowAlpha] doubleValue] <= 0) continue;
        CGRect b;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &b)) continue;
        if (!CGRectContainsPoint(b, point)) continue;
        found = [window[(id)kCGWindowNumber] unsignedIntValue];
        *owner = pid;
        *bounds = b;
        break;
    }
    if (list) CFRelease(list);
    return found;
}

/// One line to the input helper (agent-vhid-helper), and its answer; nil if it isn't there.
static NSString *askHelper(NSString *line) {
    const char *path = getenv("AGENT_VHID_SOCKET");
    if (!path || !*path) path = "/tmp/agent-vhid.sock";
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(address.sun_path)) return nil;
    strlcpy(address.sun_path, path, sizeof(address.sun_path));
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return nil;
    struct timeval timeout = {1, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
    NSString *reply = nil;
    if (connect(fd, (struct sockaddr *)&address, sizeof address) == 0) {
        const char *request = [line stringByAppendingString:@"\n"].UTF8String;
        if (write(fd, request, strlen(request)) > 0) {
            char buffer[512];
            ssize_t n = read(fd, buffer, sizeof buffer - 1);
            if (n > 0) {
                buffer[n] = 0;
                reply = [@(buffer) stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
            }
        }
    }
    close(fd);
    return reply;
}

@class HiveSwitch;

@interface HiveShare : NSObject
- (instancetype)initWithSwitch:(HiveSwitch *)hiveSwitch;
/// Hive holds the cursor and your input is being shared (not paused while the monitor is shown).
- (BOOL)active;
- (CGPoint)yourSpot;
- (pid_t)yourApp;
/// Your cursor moved while nothing is shared: remember where it is on your screens.
- (void)noteYourCursor;
/// The virtual monitor is being shown: your input is yours as it is, and stops Hive.
- (void)pause;
/// Back from the virtual monitor with Hive's cursor at `spot` (if it's on the monitor).
- (void)resumeWithHiveAt:(CGPoint)spot;
/// This process is ending: give everything back.
- (void)stop;
@end

@interface HiveSwitch : NSObject <SCStreamOutput, SCStreamDelegate>
- (void)switchOut;
- (void)toggle;
- (BOOL)isShowing;
- (void)quit;
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
    NSMutableArray<NSNumber *> *_hidden;  // your apps (pids) hidden while you're switched in
    BOOL _pictured;           // the first frame of this switch-in arrived
    id _monitor;
    HiveShare *_share;
}

- (instancetype)init {
    if (!(self = [super init])) return nil;
    _frames = dispatch_queue_create("hive.monitor-switch.frames", DISPATCH_QUEUE_SERIAL);
    NSEventMask mask = NSEventMaskFlagsChanged | NSEventMaskKeyDown | NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown |
                       NSEventMaskOtherMouseDown | NSEventMaskScrollWheel | NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged |
                       NSEventMaskRightMouseDragged | NSEventMaskOtherMouseDragged;
    __weak HiveSwitch *weakSelf = self;
    _monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event) { [weakSelf handle:event]; }];
    _share = [[HiveShare alloc] initWithSwitch:self];
    return self;
}

- (BOOL)isShowing {
    return _showing;
}

- (void)quit {
    [self switchOut];
    [_share stop];
}

- (void)handle:(NSEvent *)event {
    NSEventType type = event.type;
    if (!_showing && (type == NSEventTypeMouseMoved || type == NSEventTypeLeftMouseDragged)) [_share noteYourCursor];
    if ([_share active]) return;  // while Hive holds the cursor, the share's own tap hears your keys
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
    if (!display) { fprintf(stderr, "switch: the virtual monitor is off\n"); beepUnlessMuted(); return; }
    if (!CGPreflightScreenCaptureAccess()) {
        fprintf(stderr, "switch: no Screen Recording permission, so the virtual monitor can't be shown\n");
        beepUnlessMuted();
        return;
    }
    _display = display;
    _area = CGDisplayBounds(display);
    NSScreen *screen = [self yourScreen];
    if (!screen) { fprintf(stderr, "switch: no screen of yours to show it on\n"); return; }
    CGPoint here = cursorNow();
    pid_t previous = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    if ([_share active]) {  // Hive holds the cursor: you come back to your drawn one, and your app
        _lastThere = here;
        _hasLastThere = CGRectContainsPoint(_area, here);
        here = [_share yourSpot];
        previous = [_share yourApp];
        [_share pause];
    }
    if (CGRectContainsPoint(_area, here)) {  // the agent left the cursor there: come back to your screen's middle
        CGFloat primaryHeight = NSScreen.screens.firstObject.frame.size.height;
        here = CGPointMake(NSMidX(screen.frame), primaryHeight - NSMidY(screen.frame));
    }
    _returnTo = here;
    _previous = previous;
    _showing = YES;
    _pictured = NO;
    [self showOn:screen];
    [self hideYourWindows:screen];
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
    [self unhideYourWindows];  // under the picture still, so they're simply there when it goes
    [_window orderOut:nil];
    _picture.contents = nil;
    CGPoint here = cursorNow();
    if (CGRectContainsPoint(_area, here)) { _lastThere = here; _hasLastThere = YES; }
    moveCursor(_returnTo);
    bringForward(_previous);
    fprintf(stderr, "switch: back on your screen\n");
    [_share resumeWithHiveAt:_hasLastThere ? _lastThere : CGPointMake(CGRectGetMidX(_area), CGRectGetMidY(_area))];
}

/// Hides, under the picture, every app whose windows are on your screen and not on the virtual
/// monitor, so Mission Control's opening and closing moments can't show them (kPictureSpaces).
/// An app with a window on the virtual monitor stays: hiding it would hide that window too.
- (void)hideYourWindows:(NSScreen *)screen {
    if (!_hidden) _hidden = [NSMutableArray array];
    CGRect yours = CGDisplayBounds([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue]);
    NSMutableSet<NSNumber *> *only = ownersOn(yours);
    [only minusSet:ownersOn(_area)];
    [only removeObject:@(getpid())];
    for (NSNumber *pid in only) {
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid.intValue];
        if (!app || app.hidden || app.activationPolicy != NSApplicationActivationPolicyRegular) continue;
        if (setAppHidden(pid.intValue, YES)) [_hidden addObject:pid];
    }
    if (_hidden.count) fprintf(stderr, "switch: hid %lu app(s) on your screen\n", (unsigned long)_hidden.count);
}

/// Shows again what `hideYourWindows` hid (an app you opened meanwhile already is).
- (void)unhideYourWindows {
    for (NSNumber *pid in _hidden) setAppHidden(pid.intValue, NO);
    [_hidden removeAllObjects];
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
        _window.collectionBehavior = kPictureSpaces;  // no flash of your windows in Mission Control
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

static CGEventRef shareTapped(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info);

@implementation HiveShare {
    __weak HiveSwitch *_switch;
    BOOL _holding;
    BOOL _paused;             // the virtual monitor is shown
    BOOL _secure;             // Secure Input is on: the helper was told to let your hands stop Hive
    CGRect _area;             // the virtual monitor, global top-left coordinates
    CGRect _screens[16];      // yours
    int _screenCount;
    CGPoint _hiveSpot;        // where the real cursor belongs while Hive holds it
    CGPoint _lastHiveSpot;
    BOOL _hasLastHiveSpot;
    CGPoint _yourSpot;        // your drawn cursor
    BOOL _hasYourSpot;
    pid_t _hiveApp;
    pid_t _yourApp;
    BOOL _pressing;           // the real cursor is yours, for a click of yours (until a moment after)
    NSUInteger _press;        // which click a later hand-back belongs to
    double _heard;            // when Hive last held or used its input
    OptionTap _tap;
    NSSet<NSNumber *> *_hiveDevices;
    NSMutableSet<NSNumber *> *_senders;  // devices seen since holding
    CFMachPortRef _port;
    CFRunLoopSourceRef _source;
    NSWindow *_cursor;
    NSPoint _hotSpot;
    CGWindowID _scrollWindow;
    pid_t _scrollOwner;
    CGRect _scrollBounds;
    CGPoint _scrollSpot;
    double _scrolledAt;
    dispatch_source_t _listener;
    dispatch_source_t _timer;
    dispatch_queue_t _helperQueue;
    NSString *_socketPath;
    id _activations;
}

- (instancetype)initWithSwitch:(HiveSwitch *)hiveSwitch {
    if (!(self = [super init])) return nil;
    _switch = hiveSwitch;
    _helperQueue = dispatch_queue_create("hive.monitor-share.helper", DISPATCH_QUEUE_SERIAL);
    __weak HiveShare *weakSelf = self;
    _activations = [NSWorkspace.sharedWorkspace.notificationCenter
        addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:NSOperationQueue.mainQueue
                usingBlock:^(NSNotification *note) {
                    NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
                    [weakSelf activated:app.processIdentifier];
                }];
    [self openSocket];
    return self;
}

- (BOOL)active { return _holding && !_paused; }
- (CGPoint)yourSpot { return _yourSpot; }
- (pid_t)yourApp { return _yourApp; }

/// An app came forward: by your click while the cursor is yours, else by Hive.
- (void)activated:(pid_t)pid {
    if (!_holding || _paused || pid <= 0 || pid == getpid()) return;
    if (_pressing) _yourApp = pid;
    else if (pid != _yourApp) _hiveApp = pid;
}

- (void)noteYourCursor {
    if (_holding) return;
    CGPoint here = cursorNow();
    CGDirectDisplayID display = 0;
    uint32_t count = 0;
    if (CGGetDisplaysWithPoint(here, 1, &display, &count) != kCGErrorSuccess || count != 1) return;
    if (CGDisplayVendorNumber(display) == kHiveVendor && CGDisplayModelNumber(display) == kHiveProduct) return;
    _yourSpot = here;
    _hasYourSpot = YES;
}

- (void)findYourScreens {
    CGDirectDisplayID ids[16];
    uint32_t count = 0;
    _screenCount = 0;
    if (CGGetActiveDisplayList(16, ids, &count) != kCGErrorSuccess) return;
    for (uint32_t i = 0; i < count && _screenCount < 16; i++) {
        if (CGDisplayVendorNumber(ids[i]) == kHiveVendor && CGDisplayModelNumber(ids[i]) == kHiveProduct) continue;
        if (CGDisplayMirrorsDisplay(ids[i]) != kCGNullDirectDisplay) continue;
        _screens[_screenCount++] = CGDisplayBounds(ids[i]);
    }
}

// -- holding --

- (NSString *)hold:(pid_t)pid {
    if ([_switch isShowing]) return @"err showing";
    CGDirectDisplayID display = onlineHiveDisplay();
    if (!display) { [self releaseHold]; return @"err off"; }
    _area = CGDisplayBounds(display);
    [self findYourScreens];
    if (!_screenCount) return @"err no-screen";
    _heard = NSProcessInfo.processInfo.systemUptime;
    if (pid > 0 && pid != getpid()) _hiveApp = pid;
    if (_holding) return @"ok holding";
    if (![self startTap]) return @"err no-tap";
    _hiveDevices = hiveDevices();
    _senders = [NSMutableSet set];
    CGPoint here = cursorNow();
    if (CGRectContainsPoint(_area, here)) {
        _hiveSpot = here;
        if (!_hasYourSpot) _yourSpot = CGPointMake(CGRectGetMidX(_screens[0]), CGRectGetMidY(_screens[0]));
    } else {
        _yourSpot = here;
        _hiveSpot = _hasLastHiveSpot && CGRectContainsPoint(_area, _lastHiveSpot)
                        ? _lastHiveSpot : CGPointMake(CGRectGetMidX(_area), CGRectGetMidY(_area));
    }
    _yourSpot = nearestOn(_yourSpot, _screens, _screenCount);
    pid_t front = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    pid_t hiveFront = frontOwnerOn(_area);
    if (front > 0 && front != getpid() && (front != hiveFront || _yourApp <= 0)) _yourApp = front;
    if (_hiveApp <= 0) _hiveApp = hiveFront;
    _holding = YES;
    _paused = NO;
    _pressing = NO;
    _press++;
    _secure = NO;
    _tap = (OptionTap){0};
    moveCursor(_hiveSpot);
    [self drawYourCursor];
    [self startTimer];
    fprintf(stderr, "share: Hive holds the cursor; yours is drawn (%lu Hive device(s), your app %d, Hive's %d)\n",
            (unsigned long)_hiveDevices.count, _yourApp, _hiveApp);
    return @"ok holding";
}

- (void)releaseHold {
    if (!_holding) return;
    _holding = NO;
    _pressing = NO;
    _press++;
    [self stopTap];
    [self stopTimer];
    [_cursor orderOut:nil];
    if (CGRectContainsPoint(_area, _hiveSpot)) { _lastHiveSpot = _hiveSpot; _hasLastHiveSpot = YES; }
    if (!_paused) {
        moveCursor(_yourSpot);
        if (_yourApp > 0 && kill(_yourApp, 0) == 0) bringForward(_yourApp);
    }
    _paused = NO;
    fprintf(stderr, "share: the cursor is yours again\n");
}

- (void)pause {
    if (!_holding || _paused) return;
    _paused = YES;
    _pressing = NO;
    _press++;
    [_cursor orderOut:nil];
    [self tellHelper:@"share off"];
}

- (void)resumeWithHiveAt:(CGPoint)spot {
    if (!_holding || !_paused) return;
    _paused = NO;
    CGPoint here = cursorNow();
    if (!CGRectContainsPoint(_area, here)) _yourSpot = nearestOn(here, _screens, _screenCount);
    if (CGRectContainsPoint(_area, spot)) _hiveSpot = spot;
    _heard = NSProcessInfo.processInfo.systemUptime;
    _tap = (OptionTap){0};
    moveCursor(_hiveSpot);
    [self drawYourCursor];
    if (!_secure) [self tellHelper:@"share on"];
    if (_hiveApp > 0 && kill(_hiveApp, 0) == 0) bringForward(_hiveApp);
}

- (void)stop {
    BOOL was = _holding;
    [self releaseHold];
    if (was) askHelper(@"share off");  // now: the process is ending
    if (_socketPath) unlink(_socketPath.fileSystemRepresentation);
}

- (void)tellHelper:(NSString *)line {
    dispatch_async(_helperQueue, ^{
        NSString *reply = askHelper(line);
        fprintf(stderr, "share: input helper %s: %s\n", line.UTF8String, reply ? reply.UTF8String : "no answer");
    });
}

/// Every quarter second while holding: let go if Hive went quiet or the monitor went away, follow
/// your screens, and watch Secure Input.
- (void)tick {
    if (!_holding) return;
    if (NSProcessInfo.processInfo.systemUptime - _heard > kShareQuietSeconds) {
        fprintf(stderr, "share: nothing from Hive for %.0f s\n", kShareQuietSeconds);
        [self releaseHold];
        [self tellHelper:@"share off"];
        return;
    }
    CGDirectDisplayID display = onlineHiveDisplay();
    if (!display || !CGRectEqualToRect(CGDisplayBounds(display), _area)) {
        fprintf(stderr, "share: the virtual monitor went away or moved\n");
        [self releaseHold];
        [self tellHelper:@"share off"];
        return;
    }
    [self findYourScreens];
    if (_paused || !_screenCount) return;
    BOOL secure = IsSecureEventInputEnabled();
    if (secure != _secure) {
        _secure = secure;
        fprintf(stderr, "share: Secure Input %s\n", secure ? "on: your hands stop Hive meanwhile" : "off");
        [self tellHelper:secure ? @"share off" : @"share on"];
    }
}

- (void)startTimer {
    if (_timer) return;
    _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(_timer, dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), 250 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
    __weak HiveShare *weakSelf = self;
    dispatch_source_set_event_handler(_timer, ^{ [weakSelf tick]; });
    dispatch_resume(_timer);
}

- (void)stopTimer {
    if (!_timer) return;
    dispatch_source_cancel(_timer);
    _timer = nil;
}

// -- the tap --

- (BOOL)startTap {
    if (_port) return YES;
    CGEventMask mask = CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDown) |
                       CGEventMaskBit(kCGEventLeftMouseUp) | CGEventMaskBit(kCGEventRightMouseDown) |
                       CGEventMaskBit(kCGEventRightMouseUp) | CGEventMaskBit(kCGEventOtherMouseDown) |
                       CGEventMaskBit(kCGEventOtherMouseUp) | CGEventMaskBit(kCGEventLeftMouseDragged) |
                       CGEventMaskBit(kCGEventRightMouseDragged) | CGEventMaskBit(kCGEventOtherMouseDragged) |
                       CGEventMaskBit(kCGEventScrollWheel) | CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
                       CGEventMaskBit(kCGEventFlagsChanged) |
                       // trackpad gestures: rotate, gesture, magnify, swipe, smart magnify, pressure
                       CGEventMaskBit(18) | CGEventMaskBit(29) | CGEventMaskBit(30) | CGEventMaskBit(31) |
                       CGEventMaskBit(32) | CGEventMaskBit(34);
    _port = CGEventTapCreate(kCGHIDEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, shareTapped,
                             (__bridge void *)self);
    if (!_port) { fprintf(stderr, "share: macOS refused the input tap\n"); return NO; }
    _source = CFMachPortCreateRunLoopSource(NULL, _port, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), _source, kCFRunLoopCommonModes);
    CGEventTapEnable(_port, true);
    return YES;
}

- (void)stopTap {
    if (!_port) return;
    CGEventTapEnable(_port, false);
    CFRunLoopRemoveSource(CFRunLoopGetMain(), _source, kCFRunLoopCommonModes);
    CFMachPortInvalidate(_port);
    CFRelease(_source);
    CFRelease(_port);
    _source = NULL;
    _port = NULL;
}

- (CGEventRef)tapped:(CGEventRef)event type:(CGEventType)type {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (_port && _holding) CGEventTapEnable(_port, true);
        return event;
    }
    if (!_holding || _paused) return event;
    IOHIDEventRef hid = CGEventCopyIOHIDEvent(event);
    uint64_t sender = hid ? IOHIDEventGetSenderID(hid) : 0;
    if (hid) CFRelease(hid);
    if (sender && ![_senders containsObject:@(sender)]) {  // a device not seen since holding: which are Hive's?
        [_senders addObject:@(sender)];
        _hiveDevices = hiveDevices();
    }
    switch (inputFrom(sender, type, _pressing, _hiveDevices)) {
        case FromHive:
            _heard = NSProcessInfo.processInfo.systemUptime;
            return [self hives:event type:type];
        case FromYou:
            return [self yours:event type:type];
        default:
            return event;
    }
}

/// Hive's own input: it passes, on Hive's spot.
- (CGEventRef)hives:(CGEventRef)event type:(CGEventType)type {
    switch (type) {
        case kCGEventMouseMoved:
        case kCGEventLeftMouseDragged:
        case kCGEventRightMouseDragged:
        case kCGEventOtherMouseDragged: {
            CGPoint at = CGEventGetLocation(event);
            CGPoint step = CGPointMake(CGEventGetDoubleValueField(event, kCGMouseEventDeltaX),
                                       CGEventGetDoubleValueField(event, kCGMouseEventDeltaY));
            _hiveSpot = hiveSpotAfterMove(_hiveSpot, at, step, _area);
            if (_pressing) return NULL;  // the real cursor is yours for your click; Hive's comes back after
            if (!samePoint(at, _hiveSpot)) {
                moveCursor(_hiveSpot);
                CGEventSetLocation(event, _hiveSpot);
            }
            return event;
        }
        case kCGEventLeftMouseDown:
        case kCGEventLeftMouseUp:
        case kCGEventRightMouseDown:
        case kCGEventRightMouseUp:
        case kCGEventOtherMouseDown:
        case kCGEventOtherMouseUp:
        case kCGEventScrollWheel:
            if (_pressing) [self endYourClick];  // Hive's click takes the cursor back now
            if (!samePoint(cursorNow(), _hiveSpot)) moveCursor(_hiveSpot);
            CGEventSetLocation(event, _hiveSpot);
            return event;
        default:
            return event;
    }
}

/// Your input: a drawn cursor, real clicks there, and keys and scrolling sent to your app.
- (CGEventRef)yours:(CGEventRef)event type:(CGEventType)type {
    unsigned short code = (type == kCGEventKeyDown || type == kCGEventFlagsChanged)
                              ? (unsigned short)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) : 0;
    if (optionTapObserve(&_tap, (NSEventType)type, code, (NSEventModifierFlags)CGEventGetFlags(event),
                         NSProcessInfo.processInfo.systemUptime)) {
        fprintf(stderr, "switch: right Option tapped\n");
        __weak HiveSwitch *hiveSwitch = _switch;
        dispatch_async(dispatch_get_main_queue(), ^{ [hiveSwitch toggle]; });
    }
    switch (type) {
        case kCGEventMouseMoved:
        case kCGEventLeftMouseDragged:
        case kCGEventRightMouseDragged:
        case kCGEventOtherMouseDragged: {
            if (_pressing) {  // the real cursor is yours for now: it moves, on your screens
                CGPoint at = CGEventGetLocation(event);
                _yourSpot = nearestOn(at, _screens, _screenCount);
                if (!samePoint(at, _yourSpot)) {
                    moveCursor(_yourSpot);
                    CGEventSetLocation(event, _yourSpot);
                }
                return event;
            }
            CGPoint step = CGPointMake(CGEventGetDoubleValueField(event, kCGMouseEventDeltaX),
                                       CGEventGetDoubleValueField(event, kCGMouseEventDeltaY));
            _yourSpot = nearestOn(CGPointMake(_yourSpot.x + step.x, _yourSpot.y + step.y), _screens, _screenCount);
            moveCursor(_hiveSpot);
            [self drawYourCursor];
            return NULL;
        }
        case kCGEventLeftMouseDown:
        case kCGEventRightMouseDown:
        case kCGEventOtherMouseDown:
            _pressing = YES;
            _press++;
            [_cursor orderOut:nil];
            moveCursor(_yourSpot);
            CGEventSetLocation(event, _yourSpot);
            return event;
        case kCGEventLeftMouseUp:
        case kCGEventRightMouseUp:
        case kCGEventOtherMouseUp: {
            CGEventSetLocation(event, _yourSpot);
            NSUInteger press = ++_press;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kClickSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                if (self->_press == press) [self endYourClick];
            });
            return event;
        }
        case kCGEventScrollWheel:
            [self scrollYours:event];
            return NULL;
        case kCGEventKeyDown:
        case kCGEventKeyUp:
        case kCGEventFlagsChanged:
            [self typeYours:event];
            return NULL;
        default:
            return NULL;  // trackpad gestures would act on Hive's app
    }
}

/// A moment after a click of yours (or at once, when Hive clicks): the real cursor goes back to
/// Hive's spot, the app you clicked is yours, and Hive's app comes forward again.
- (void)endYourClick {
    if (!_pressing) return;
    _pressing = NO;
    _press++;
    if (!_holding || _paused) return;
    CGPoint here = cursorNow();
    if (!CGRectContainsPoint(_area, here)) _yourSpot = nearestOn(here, _screens, _screenCount);
    pid_t front = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    if (front > 0 && front != getpid()) _yourApp = front;
    moveCursor(_hiveSpot);
    [self drawYourCursor];
    if (_hiveApp > 0 && _hiveApp != front && kill(_hiveApp, 0) == 0) bringForward(_hiveApp);
}

- (void)typeYours:(CGEventRef)event {
    pid_t app = _yourApp;
    if (app <= 0 || kill(app, 0) != 0) return;
    CGEventRef copy = CGEventCreateCopy(event);
    if (!copy) return;
    CGEventPostToPid(app, copy);
    CFRelease(copy);
}

- (void)scrollYours:(CGEventRef)event {
    double now = NSProcessInfo.processInfo.systemUptime;
    if (!samePoint(_scrollSpot, _yourSpot) || now - _scrolledAt > 1.0) {
        _scrollSpot = _yourSpot;
        _scrollOwner = 0;
        _scrollWindow = windowAt(_yourSpot, &_scrollOwner, &_scrollBounds);
    }
    _scrolledAt = now;
    if (!_scrollWindow || _scrollOwner <= 0) return;
    CGEventRef copy = CGEventCreateCopy(event);
    if (!copy) return;
    CGEventSetLocation(copy, _yourSpot);
    CGEventSetIntegerValueField(copy, kTargetWindowField, _scrollWindow);
    CGEventSetWindowLocation(copy, CGPointMake(_yourSpot.x - _scrollBounds.origin.x, _yourSpot.y - _scrollBounds.origin.y));
    CGEventPostToPid(_scrollOwner, copy);
    CFRelease(copy);
}

/// Your cursor, drawn where your mouse is (the real one is on Hive's work).
- (void)drawYourCursor {
    if (!_cursor) {
        NSCursor *arrow = NSCursor.arrowCursor;
        NSImage *image = arrow.image;
        _hotSpot = arrow.hotSpot;
        _cursor = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, image.size.width, image.size.height)
                                              styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        _cursor.releasedWhenClosed = NO;
        _cursor.opaque = NO;
        _cursor.backgroundColor = NSColor.clearColor;
        _cursor.hasShadow = NO;
        _cursor.ignoresMouseEvents = YES;
        _cursor.level = CGWindowLevelForKey(kCGCursorWindowLevelKey) - 1;
        _cursor.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary |
                                     NSWindowCollectionBehaviorIgnoresCycle | NSWindowCollectionBehaviorFullScreenAuxiliary;
        NSImageView *view = [NSImageView imageViewWithImage:image];
        view.frame = NSMakeRect(0, 0, image.size.width, image.size.height);
        _cursor.contentView = view;
    }
    CGFloat primaryHeight = NSScreen.screens.firstObject.frame.size.height;
    NSSize size = _cursor.frame.size;
    [_cursor setFrameOrigin:NSMakePoint(_yourSpot.x - _hotSpot.x, primaryHeight - _yourSpot.y + _hotSpot.y - size.height)];
    if (!_cursor.visible) [_cursor orderFrontRegardless];
}

// -- the socket Hive talks to --

- (void)openSocket {
    _socketPath = [stateDir() stringByAppendingPathComponent:@"monitor-share.sock"];
    const char *path = _socketPath.fileSystemRepresentation;
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(address.sun_path)) { fprintf(stderr, "share: socket path too long: %s\n", path); return; }
    strlcpy(address.sun_path, path, sizeof(address.sun_path));
    unlink(path);  // one switch at a time (its lock), so an old socket is a leftover
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return;
    mode_t old = umask(0177);
    int bound = bind(fd, (struct sockaddr *)&address, sizeof address);
    umask(old);
    if (bound != 0 || listen(fd, 8) != 0) {
        fprintf(stderr, "share: can't listen on %s (%s)\n", path, strerror(errno));
        close(fd);
        return;
    }
    fcntl(fd, F_SETFL, O_NONBLOCK);
    _listener = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)fd, 0, dispatch_get_main_queue());
    __weak HiveShare *weakSelf = self;
    dispatch_source_set_event_handler(_listener, ^{
        int client = accept(fd, NULL, NULL);
        if (client >= 0) [weakSelf serve:client];
    });
    dispatch_resume(_listener);
}

- (void)serve:(int)client {
    uid_t uid = 0;
    gid_t gid = 0;
    if (getpeereid(client, &uid, &gid) != 0 || uid != getuid()) { close(client); return; }
    int one = 1;
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
    fcntl(client, F_SETFL, O_NONBLOCK);
    NSMutableData *pending = [NSMutableData data];
    __block dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)client, 0, dispatch_get_main_queue());
    __weak HiveShare *weakSelf = self;
    dispatch_source_set_event_handler(source, ^{
        char chunk[512];
        ssize_t n = read(client, chunk, sizeof chunk);
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) return;
        if (n <= 0 || pending.length + (NSUInteger)n > 4096) { dispatch_source_cancel(source); return; }
        [pending appendBytes:chunk length:(NSUInteger)n];
        while (pending.length) {
            const char *bytes = pending.bytes;
            const char *newline = memchr(bytes, '\n', pending.length);
            if (!newline) break;
            NSUInteger length = (NSUInteger)(newline - bytes);
            NSString *line = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding] ?: @"";
            [pending replaceBytesInRange:NSMakeRange(0, length + 1) withBytes:NULL length:0];
            NSString *answer = [weakSelf execute:line] ?: @"err gone";
            const char *text = [answer stringByAppendingString:@"\n"].UTF8String;
            if (write(client, text, strlen(text)) < 0) { dispatch_source_cancel(source); return; }
        }
    });
    dispatch_source_set_cancel_handler(source, ^{ close(client); source = nil; });
    dispatch_resume(source);
}

- (NSString *)execute:(NSString *)line {
    NSArray<NSString *> *words = [[line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
        componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    NSString *command = words.firstObject ?: @"";
    if ([command isEqualToString:@"hold"]) return [self hold:words.count > 1 ? (pid_t)words[1].intValue : 0];
    if ([command isEqualToString:@"release"]) { [self releaseHold]; return @"ok"; }
    if ([command isEqualToString:@"status"])
        return [NSString stringWithFormat:@"ok holding=%d showing=%d", _holding ? 1 : 0, [_switch isShowing] ? 1 : 0];
    return [@"err unknown command: " stringByAppendingString:command];
}
@end

static CGEventRef shareTapped(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
    (void)proxy;
    return [(__bridge HiveShare *)info tapped:event type:type];
}

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
    dispatch_block_t stop = ^{ [hiveSwitch quit]; exit(0); };
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
    CHECK((kPictureSpaces & NSWindowCollectionBehaviorStationary) && (kPictureSpaces & NSWindowCollectionBehaviorCanJoinAllSpaces),
          "the picture is on every Space and stays put in Mission Control");
    CHECK(!(kPictureSpaces & NSWindowCollectionBehaviorFullScreenAuxiliary),
          "the picture is never full-screen auxiliary: Mission Control would shrink it and show your own windows");
    CGRect screens[2] = {CGRectMake(0, 0, 1710, 1107), CGRectMake(1710, 0, 1920, 1080)};
    CGPoint yours = nearestOn(CGPointMake(100, 100), screens, 2);
    CHECK(yours.x == 100 && yours.y == 100, "your drawn cursor on your screen stays put");
    yours = nearestOn(CGPointMake(-500, 300), screens, 2);
    CHECK(yours.x == 0 && yours.y == 300, "your drawn cursor never goes onto the virtual monitor");
    yours = nearestOn(CGPointMake(2000, 1100), screens, 2);
    CHECK(yours.x == 2000 && yours.y == 1079, "your drawn cursor stops at the bottom of a shorter screen");
    CGRect monitor = CGRectMake(-1440, 0, 1440, 900);
    CGPoint hive = hiveSpotAfterMove(CGPointMake(-700, 400), CGPointMake(-695.4, 403.2), CGPointMake(5, 3), monitor);
    CHECK(hive.x == -695.4 && hive.y == 403.2, "Hive's move lands where the event says");
    hive = hiveSpotAfterMove(CGPointMake(-700, 400), CGPointMake(-655, 403), CGPointMake(5, 3), monitor);
    CHECK(hive.x == -695 && hive.y == 403, "Hive's move counts from its own spot when yours knocked the cursor off it");
    hive = hiveSpotAfterMove(CGPointMake(-3, 400), CGPointMake(7, 400), CGPointMake(10, 0), monitor);
    CHECK(hive.x == -1 && hive.y == 400, "Hive's cursor stays on the virtual monitor");
    NSSet<NSNumber *> *devices = [NSSet setWithObject:@(0x100000e51ULL)];
    CHECK(inputFrom(0x100000e51ULL, kCGEventMouseMoved, NO, devices) == FromHive, "Karabiner's mouse is Hive");
    CHECK(inputFrom(0x100000a20ULL, kCGEventMouseMoved, NO, devices) == FromYou, "the trackpad is you");
    CHECK(inputFrom(0, kCGEventLeftMouseDragged, YES, devices) == FromYou, "a drag while your button is down is yours");
    CHECK(inputFrom(0, kCGEventLeftMouseDragged, NO, devices) == FromHive, "any other drag is Hive's");
    CHECK(inputFrom(0, kCGEventKeyDown, NO, devices) == FromElsewhere, "an event no device sent passes untouched");
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
