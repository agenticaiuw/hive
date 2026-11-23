#import "Catch.h"

id HiveTry(id (NS_NOESCAPE ^block)(void), NSString **error) {
  @try {
    return block();
  } @catch (NSException *e) {
    if (error) *error = e.reason ?: e.name;
    return nil;
  }
}
