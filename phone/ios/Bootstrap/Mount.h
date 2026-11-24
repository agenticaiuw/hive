#import <Foundation/Foundation.h>

@interface HiveMount : NSObject
// Completion and progress are delivered on the main queue.
+ (void)start:(void (^)(NSString *))progress completion:(void (^)(BOOL))completion;
@end
