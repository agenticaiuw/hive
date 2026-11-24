// Hive's initial executable uses only system frameworks. XCTest is loaded only
// after the developer image is mounted, so a reboot cannot prevent this app
// from reaching its mount code.
#import <UIKit/UIKit.h>
#import <TargetConditionals.h>
#import <dlfcn.h>
#if !TARGET_OS_SIMULATOR
#import "Mount.h"
#endif

@interface HiveBootstrap : UIResponder <UIApplicationDelegate, UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic) BOOL started;
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
- (void)applicationDidBecomeActive:(UIApplication *)application { [self start]; }
- (void)sceneDidBecomeActive:(UIScene *)scene { [(HiveBootstrap *)UIApplication.sharedApplication.delegate start]; }
- (void)start {
    if (self.started) return;
    self.started = YES;
#if TARGET_OS_SIMULATOR
    // The simulator has no personalized DDI; build.sh embeds its XCTest runtime.
    dispatch_async(dispatch_get_main_queue(), ^{ [self runXCTest]; });
#else
    [HiveMount start:^(NSString *status) { self.status.text = status; } completion:^(BOOL mounted) {
        if (mounted) [self runXCTest];
        else self.started = NO;
    }];
#endif
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
    id configuration = [configurationClass new];
    NSURL *bundle = [NSBundle.mainBundle.builtInPlugInsURL URLByAppendingPathComponent:@"HivePhone.xctest"];
    @try {
        [configuration setValue:bundle forKey:@"testBundleURL"];
        [configuration setValue:NSUUID.UUID forKey:@"sessionIdentifier"];
        [configuration setValue:@YES forKey:@"initializeForUITesting"];
        [configuration setValue:@YES forKey:@"testsMustRunOnMainThread"];
        [configuration setValue:@NO forKey:@"reportResultsToIDE"];
        run(configuration);
    } @catch (NSException *exception) {
        self.status.text = @"Hive couldn’t start phone control.";
    }
}
@end

int main(int argc, char **argv) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(HiveBootstrap.class)); }
}
