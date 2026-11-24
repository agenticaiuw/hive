// Hive's initial executable uses only system frameworks. XCTest is loaded only
// after the developer image is mounted, so a reboot cannot prevent this app
// from reaching its mount code.
#import <UIKit/UIKit.h>
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

@interface HiveBootstrap : UIResponder <UIApplicationDelegate, UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic) BOOL started;
@property(nonatomic) UIBackgroundTaskIdentifier backgroundTask;
@end

@implementation HiveBootstrap
- (void)showInScene:(UIWindowScene *)scene {
    if (self.window) return;
    self.window = scene ? [[UIWindow alloc] initWithWindowScene:scene] : [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    UIViewController *controller = [UIViewController new];
    controller.view.backgroundColor = UIColor.systemBackgroundColor;
    self.status = [UILabel new];
    self.status.text = @"Starting Hive…";
    self.status.numberOfLines = 0;
    self.status.textAlignment = NSTextAlignmentCenter;
    self.status.translatesAutoresizingMaskIntoConstraints = NO;
    [controller.view addSubview:self.status];
    [NSLayoutConstraint activateConstraints:@[
        [self.status.leadingAnchor constraintEqualToAnchor:controller.view.safeAreaLayoutGuide.leadingAnchor constant:24],
        [self.status.trailingAnchor constraintEqualToAnchor:controller.view.safeAreaLayoutGuide.trailingAnchor constant:-24],
        [self.status.centerYAnchor constraintEqualToAnchor:controller.view.centerYAnchor]
    ]];
    self.window.rootViewController = controller;
    [self.window makeKeyAndVisible];
}
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    self.backgroundTask = UIBackgroundTaskInvalid;
    if (![NSBundle.mainBundle objectForInfoDictionaryKey:@"UIApplicationSceneManifest"]) [self showInScene:nil];
    return YES;
}
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    UISceneConfiguration *configuration = [[UISceneConfiguration alloc] initWithName:@"Hive" sessionRole:session.role];
    configuration.delegateClass = self.class;
    return configuration;
}
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    if ([scene isKindOfClass:UIWindowScene.class]) [(HiveBootstrap *)UIApplication.sharedApplication.delegate showInScene:(UIWindowScene *)scene];
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
- (void)sceneWillResignActive:(UIScene *)scene { [(HiveBootstrap *)UIApplication.sharedApplication.delegate continueInBackground]; }
- (void)applicationDidBecomeActive:(UIApplication *)application { [self endBackgroundTask]; [self start]; }
- (void)sceneDidBecomeActive:(UIScene *)scene {
    HiveBootstrap *app = (HiveBootstrap *)UIApplication.sharedApplication.delegate;
    [app endBackgroundTask];
    [app start];
}
- (void)start {
    if (self.started) return;
    self.started = YES;
#if TARGET_OS_SIMULATOR
    // The simulator has no personalized DDI; build.sh embeds its XCTest runtime.
    [self scheduleXCTest];
#else
    [HiveMount start:^(NSString *status) { self.status.text = status; } completion:^(BOOL mounted) {
        if (mounted) [self scheduleXCTest];
        else self.started = NO;
    }];
#endif
}
- (void)scheduleXCTest {
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
        self.status.text = @"Hive couldn’t load phone control from the developer image.";
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
        if (error) { self.status.text = @"Hive couldn’t configure phone control."; return; }
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
        self.status.text = @"Hive couldn’t start phone control.";
    }
}
@end

int main(int argc, char **argv) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(HiveBootstrap.class)); }
}
