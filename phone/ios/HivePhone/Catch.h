#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
// Swift can't catch an Objective-C exception, and NSPredicate raises one for a search it can't parse or evaluate: this
// turns it into an error instead of ending Hive Phone.
id _Nullable HiveTry(id _Nullable (NS_NOESCAPE ^block)(void), NSString *_Nullable *_Nullable error);
NS_ASSUME_NONNULL_END
