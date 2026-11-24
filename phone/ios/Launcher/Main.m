// Hive's initial executable uses only system frameworks and HiveApp (the dashboard,
// Tailscale and the link to Hive Server), which are up from launch. XCTest, for
// phone control, is loaded only after the developer image is mounted, so a reboot
// or a phone that isn't set up yet cannot keep the app from the rest.
#import <UIKit/UIKit.h>
#import <HiveApp/HiveApp-Swift.h>
#import <TargetConditionals.h>
#import <CoreFoundation/CoreFoundation.h>
#import <dlfcn.h>
#if !TARGET_OS_SIMULATOR
#import "Mount.h"
#endif

// Resolve this API only after loading XCTest; Apple's runner obtains its
// complete configuration from this factory rather than constructing one.
@interface NSObject (HiveXCTestConfiguration)
+ (id)configurationFromCommandLineArguments:(NSArray *)arguments userDefaults:(NSUserDefaults *)defaults requiresTestBundleURL:(BOOL)required outError:(NSError **)error;
@end

@interface HiveLauncher : UIResponder <UIApplicationDelegate, UIWindowSceneDelegate>
@property(nonatomic) BOOL started, waiting;
@property(nonatomic) UIBackgroundTaskIdentifier backgroundTask;
@end

@implementation HiveLauncher
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    self.backgroundTask = UIBackgroundTaskInvalid;
    [HiveDashboard show];
    [HiveLink.shared start];
    return YES;
}
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    UISceneConfiguration *configuration = [[UISceneConfiguration alloc] initWithName:@"Hive" sessionRole:session.role];
    configuration.delegateClass = self.class;
    return configuration;
}
- (void)endBackgroundTask {
    if (self.backgroundTask == UIBackgroundTaskInvalid) return;
    [UIApplication.sharedApplication endBackgroundTask:self.backgroundTask];
    self.backgroundTask = UIBackgroundTaskInvalid;
}
- (void)continueInBackground {
    if (self.backgroundTask != UIBackgroundTaskInvalid) return;
    self.backgroundTask = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Hive Phone Control" expirationHandler:^{ [self endBackgroundTask]; }];
}
- (void)applicationWillResignActive:(UIApplication *)application { [self continueInBackground]; }
- (void)sceneWillResignActive:(UIScene *)scene { [(HiveLauncher *)UIApplication.sharedApplication.delegate continueInBackground]; }
- (void)applicationDidBecomeActive:(UIApplication *)application { [self endBackgroundTask]; [self start]; }
- (void)sceneDidBecomeActive:(UIScene *)scene {
    HiveLauncher *app = (HiveLauncher *)UIApplication.sharedApplication.delegate;
    [app endBackgroundTask];
    [app start];
}
- (void)start {
    if (self.started) return;
#if TARGET_OS_SIMULATOR
    // The simulator has no personalized DDI; build.sh embeds its XCTest runtime.
    self.started = YES;
    [self scheduleXCTest];
#else
    // Hive on a computer writes the pairing identity into Documents over USB once the
    // iPhone trusts it (desktop/src/phone_setup.rs): look for it until it's there.
    NSURL *documents = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *identity = [documents URLByAppendingPathComponent:@"developer-pairing.plist"];
    if (![NSFileManager.defaultManager fileExistsAtPath:identity.path]) {
        HiveLink.shared.control = @"Turn on phone control: plug this iPhone into a computer running Hive once and tap Trust.";
        if (self.waiting) return;
        self.waiting = YES;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            self.waiting = NO;
            [self start];
        });
        return;
    }
    self.started = YES;
    [HiveMount start:identity progress:^(NSString *status) { HiveLink.shared.control = status; } completion:^(BOOL mounted) {
        if (mounted) [self scheduleXCTest];
        else self.started = NO;
    }];
#endif
}
- (void)scheduleXCTest {
    HiveLink.shared.control = @"Starting phone control…";
    // _XCTestMain and testRun keep running the main run loop. Starting them
    // inside a GCD main-queue block would keep that serial block alive forever,
    // starving WebKit and XCTest's own application-state callbacks. Apple's
    // runner enters through a CFRunLoop block so the main queue can drain.
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{ [self runXCTest]; });
    CFRunLoopWakeUp(CFRunLoopGetMain());
}
- (void)runXCTest {
    NSArray<NSString *> *locations = @[
        [NSBundle.mainBundle.privateFrameworksPath stringByAppendingPathComponent:@"XCTest.framework/XCTest"],
        @"/System/Developer/Library/Frameworks/XCTest.framework/XCTest",
        @"/Developer/Library/Frameworks/XCTest.framework/XCTest"
    ];
    void *runtime = NULL;
    for (NSString *path in locations) {
        runtime = dlopen(path.fileSystemRepresentation, RTLD_NOW | RTLD_GLOBAL);
        if (runtime) break;
    }
    void (*run)(id) = runtime ? (void (*)(id))dlsym(runtime, "_XCTestMain") : NULL;
    Class configurationClass = NSClassFromString(@"XCTestConfiguration");
    if (!run || !configurationClass) {
        HiveLink.shared.control = @"Hive couldn’t load phone control from the developer image.";
        return;
    }
    // Match the runner's configured test bundle while deferring every reference
    // to XCTest until after dlopen. _XCTestMain is entered exactly once.
    NSURL *bundle = [NSBundle.mainBundle.builtInPlugInsURL URLByAppendingPathComponent:@"HivePhone.xctest"];
    @try {
        Class factory = NSClassFromString(@"XCTCommandLineToolHelper");
        NSError *error = nil;
        id configuration = nil;
        if ([factory respondsToSelector:@selector(configurationFromCommandLineArguments:userDefaults:requiresTestBundleURL:outError:)]) {
            configuration = [factory configurationFromCommandLineArguments:NSProcessInfo.processInfo.arguments
                userDefaults:NSUserDefaults.standardUserDefaults requiresTestBundleURL:NO outError:&error];
        }
        if (error) { HiveLink.shared.control = @"Hive couldn’t configure phone control."; return; }
        if (!configuration) {
            configuration = [configurationClass new];
            [configuration setValue:@YES forKey:@"reportResultsToIDE"];
            [configuration setValue:@NO forKey:@"testsDrivenByIDE"];
        }
        [configuration setValue:bundle forKey:@"testBundleURL"];
        if (![configuration valueForKey:@"sessionIdentifier"]) [configuration setValue:NSUUID.UUID forKey:@"sessionIdentifier"];
        [configuration setValue:@YES forKey:@"initializeForUITesting"];
        [configuration setValue:@YES forKey:@"testsMustRunOnMainThread"];
        if (NSProcessInfo.processInfo.environment[@"HIVE_PROBE"]) {
            NSLog(@"Hive XCTest settings UI=%@ main=%@ report=%@ driven=%@", [configuration valueForKey:@"initializeForUITesting"],
                [configuration valueForKey:@"testsMustRunOnMainThread"], [configuration valueForKey:@"reportResultsToIDE"], [configuration valueForKey:@"testsDrivenByIDE"]);
        }
        run(configuration);
    } @catch (NSException *exception) {
        HiveLink.shared.control = @"Hive couldn’t start phone control.";
    }
}
@end

int main(int argc, char **argv) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(HiveLauncher.class)); }
}
