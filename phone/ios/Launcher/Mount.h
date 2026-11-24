#import <Foundation/Foundation.h>

@interface HiveMount : NSObject
// Completion and progress are delivered on the main queue.
// identity: the Remote Pairing identity Hive on a computer saved in Documents.
+ (void)start:(NSURL *)identity progress:(void (^)(NSString *))progress completion:(void (^)(BOOL))completion;
@end
