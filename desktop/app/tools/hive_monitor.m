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
//
// The display-creation calls follow the approach of the SpaceO engine this replaces
// (CoreGraphics' CGVirtualDisplay classes, looked up at run time, on a private queue).
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>

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
        fprintf(stderr, "usage: hive-monitor serve [WIDTHxHEIGHT] | info | place PID\n");
        return 64;
    }
}
