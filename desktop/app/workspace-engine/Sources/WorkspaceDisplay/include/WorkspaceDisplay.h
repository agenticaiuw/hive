// Hive's virtual workspace display: one extra screen, invisible to the user, that only the agent's
// apps live on. It lasts exactly as long as the HiveWorkspaceDisplay object that made it, and so
// never outlives the process holding it.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

/// The vendor and product numbers every workspace display carries ("HV", 2). Hive's own virtual
/// monitor (tools/hive_monitor.m) is product 1, so the two are never mistaken for each other.
extern const uint32_t HiveWorkspaceVendor;
extern const uint32_t HiveWorkspaceProduct;

@interface HiveWorkspaceDisplay : NSObject
@property (nonatomic, readonly) CGDirectDisplayID displayID;

/// Makes the display and waits up to five seconds for it to come online. nil, with a reason in
/// `reason`, when this macOS has no virtual displays, refuses the mode, or the display never shows.
+ (nullable instancetype)createWithWidth:(uint32_t)width
                                  height:(uint32_t)height
                                    name:(NSString *)name
                                  reason:(NSString *_Nullable *_Nullable)reason;

/// Takes the display away now rather than when this object is freed.
- (void)invalidate;
@end

/// The ids of the workspace displays online right now (normally none or one).
NSArray<NSNumber *> *HiveWorkspaceDisplaysOnline(void);

/// Whether this macOS offers virtual displays at all.
BOOL HiveVirtualDisplaysAvailable(void);

NS_ASSUME_NONNULL_END
