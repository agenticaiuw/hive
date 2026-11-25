#import "Catch.h"
#import <XCTest/XCTest.h>

@interface XCUIDevice (HiveAutomation)
- (BOOL)enableAutomationMode:(NSError **)error;
@end

BOOL HiveEnableAutomation(void) {
  @try {
    XCUIDevice *device = XCUIDevice.sharedDevice;
    if (![device respondsToSelector:@selector(enableAutomationMode:)]) return NO;
    NSError *error = nil;
    return [device enableAutomationMode:&error];
  } @catch (NSException *exception) {
    return NO;
  }
}

id HiveTry(id (NS_NOESCAPE ^block)(void), NSString **error) {
  @try {
    return block();
  } @catch (NSException *e) {
    if (error) *error = e.reason ?: e.name;
    return nil;
  }
}
