// The virtual display, with CoreGraphics' CGVirtualDisplay classes looked up at run time (they are
// not in the public headers), the same way Hive's virtual monitor makes its display.
#import "WorkspaceDisplay.h"
#import <objc/runtime.h>
#include <unistd.h>

const uint32_t HiveWorkspaceVendor = 0x4856;   // "HV"
const uint32_t HiveWorkspaceProduct = 0x0002;
// One fixed serial: WindowServer and ColorSync keep a registration per serial number for good, so
// a fresh serial per launch would grow those registries without end.
static const uint32_t HiveWorkspaceSerial = 0x48565753;  // "HVWS"

// Just enough of the classes' interfaces to call them; the classes themselves come from objc_getClass.
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
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property (nonatomic, strong) NSArray *modes;
@property (nonatomic, assign) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property (nonatomic, readonly) CGDirectDisplayID displayID;
@end

BOOL HiveVirtualDisplaysAvailable(void) {
    return objc_getClass("CGVirtualDisplayDescriptor") && objc_getClass("CGVirtualDisplayMode") &&
           objc_getClass("CGVirtualDisplaySettings") && objc_getClass("CGVirtualDisplay");
}

NSArray<NSNumber *> *HiveWorkspaceDisplaysOnline(void) {
    uint32_t count = 0;
    NSMutableArray *found = [NSMutableArray array];
    if (CGGetOnlineDisplayList(0, NULL, &count) != kCGErrorSuccess || count == 0) return found;
    CGDirectDisplayID ids[32];
    if (count > 32) count = 32;
    if (CGGetOnlineDisplayList(count, ids, &count) != kCGErrorSuccess) return found;
    for (uint32_t i = 0; i < count; i++) {
        if (CGDisplayVendorNumber(ids[i]) == HiveWorkspaceVendor &&
            CGDisplayModelNumber(ids[i]) == HiveWorkspaceProduct) {
            [found addObject:@(ids[i])];
        }
    }
    return found;
}

@implementation HiveWorkspaceDisplay {
    CGVirtualDisplay *_display;  // this strong reference is the display's whole life
    dispatch_queue_t _queue;
}

+ (instancetype)createWithWidth:(uint32_t)width height:(uint32_t)height name:(NSString *)name reason:(NSString **)reason {
    if (!HiveVirtualDisplaysAvailable()) {
        if (reason) *reason = @"this macOS does not offer virtual displays";
        return nil;
    }
    HiveWorkspaceDisplay *made = [[HiveWorkspaceDisplay alloc] init];
    CGVirtualDisplayDescriptor *descriptor = [[objc_getClass("CGVirtualDisplayDescriptor") alloc] init];
    descriptor.name = name;
    descriptor.vendorID = HiveWorkspaceVendor;
    descriptor.productID = HiveWorkspaceProduct;
    descriptor.serialNum = HiveWorkspaceSerial;
    // Twice the points in pixels, so text in screenshots is as sharp as on a Retina screen.
    descriptor.maxPixelsWide = width * 2;
    descriptor.maxPixelsHigh = height * 2;
    descriptor.sizeInMillimeters = CGSizeMake(width / 4.0, height / 4.0);
    descriptor.redPrimary = CGPointMake(0.6800, 0.3200);
    descriptor.greenPrimary = CGPointMake(0.2650, 0.6900);
    descriptor.bluePrimary = CGPointMake(0.1500, 0.0600);
    descriptor.whitePoint = CGPointMake(0.3127, 0.3290);
    // CoreGraphics reports the display's life on this queue, which must not be the main one.
    made->_queue = dispatch_queue_create("hive.workspace-display", DISPATCH_QUEUE_SERIAL);
    descriptor.queue = made->_queue;

    made->_display = [[objc_getClass("CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
    if (!made->_display) {
        if (reason) *reason = @"macOS refused to create the display";
        return nil;
    }
    CGVirtualDisplaySettings *settings = [[objc_getClass("CGVirtualDisplaySettings") alloc] init];
    settings.modes = @[ [[objc_getClass("CGVirtualDisplayMode") alloc] initWithWidth:width height:height refreshRate:60.0] ];
    settings.hiDPI = 1;
    if (![made->_display applySettings:settings]) {
        settings.hiDPI = 0;
        if (![made->_display applySettings:settings]) {
            made->_display = nil;
            if (reason) *reason = @"macOS refused the display mode";
            return nil;
        }
    }
    CGDirectDisplayID displayID = made->_display.displayID;
    for (int i = 0; i < 100 && CGRectIsEmpty(CGDisplayBounds(displayID)); i++) usleep(50 * 1000);
    if (CGRectIsEmpty(CGDisplayBounds(displayID))) {
        made->_display = nil;
        if (reason) *reason = @"the display never came online";
        return nil;
    }
    return made;
}

- (CGDirectDisplayID)displayID {
    return _display ? _display.displayID : 0;
}

- (void)invalidate {
    _display = nil;
}

@end
