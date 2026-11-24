#import "Mount.h"
#import <NetworkExtension/NetworkExtension.h>
#import <dns_sd.h>
#import <sys/select.h>
#import <arpa/inet.h>

// src/lib.rs: the port is the phone's Remote Pairing listener on Hive's loopback VPN.
extern int hive_mount_ddi(uint16_t, const char *, const char *, bool);

// Discover only the local phone's listener. The saved identity is verified by
// Rust before any tunnel is requested; discovery never initiates pair setup.
typedef struct { DNSServiceRef resolver; uint16_t port; } HiveDiscovery;
static void resolved(DNSServiceRef service, DNSServiceFlags flags, uint32_t interface,
                     DNSServiceErrorType error, const char *name, const char *host,
                     uint16_t port, uint16_t length, const unsigned char *txt, void *context) {
    if (!error) ((HiveDiscovery *)context)->port = ntohs(port);
}
static void found(DNSServiceRef service, DNSServiceFlags flags, uint32_t interface,
                  DNSServiceErrorType error, const char *name, const char *type,
                  const char *domain, void *context) {
    HiveDiscovery *discovery = context;
    if (!error && (flags & kDNSServiceFlagsAdd) && !discovery->resolver) {
        DNSServiceResolve(&discovery->resolver, 0, interface, name, type, domain, resolved, context);
    }
}
static uint16_t pairingPort(void) {
    HiveDiscovery discovery = {0};
    DNSServiceRef browser = NULL;
    if (DNSServiceBrowse(&browser, 0, kDNSServiceInterfaceIndexLocalOnly,
                         "_remotepairing._tcp", "local.", found, &discovery)) return 49152;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (!discovery.port && deadline.timeIntervalSinceNow > 0) {
        int browseFD = DNSServiceRefSockFD(browser);
        int resolveFD = discovery.resolver ? DNSServiceRefSockFD(discovery.resolver) : -1;
        if (browseFD < 0) break;
        fd_set readable; FD_ZERO(&readable); FD_SET(browseFD, &readable);
        if (resolveFD >= 0) FD_SET(resolveFD, &readable);
        struct timeval timeout = { .tv_sec = 1 };
        int result = select(MAX(browseFD, resolveFD) + 1, &readable, NULL, NULL, &timeout);
        if (result < 0) break;
        if (FD_ISSET(browseFD, &readable) && DNSServiceProcessResult(browser)) break;
        if (resolveFD >= 0 && FD_ISSET(resolveFD, &readable) && DNSServiceProcessResult(discovery.resolver)) break;
    }
    if (discovery.resolver) DNSServiceRefDeallocate(discovery.resolver);
    DNSServiceRefDeallocate(browser);
    return discovery.port ?: 49152;
}

@implementation HiveMount
+ (void)start:(NSURL *)identity progress:(void (^)(NSString *))progress completion:(void (^)(BOOL))completion {
    [NSFileManager.defaultManager setAttributes:@{NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication}
                                 ofItemAtPath:identity.path error:nil];
    progress(@"Connecting phone control…");
    [NETunnelProviderManager loadAllFromPreferencesWithCompletionHandler:^(NSArray<NETunnelProviderManager *> *managers, NSError *error) {
        if (error) { dispatch_async(dispatch_get_main_queue(), ^{ progress(@"Hive couldn’t load its phone connection."); completion(NO); }); return; }
        NETunnelProviderManager *manager = nil;
        for (NETunnelProviderManager *candidate in managers) {
            NETunnelProviderProtocol *protocol = (NETunnelProviderProtocol *)candidate.protocolConfiguration;
            if ([protocol.providerBundleIdentifier isEqualToString:@"app.hive.xctrunner.loopback"]) { manager = candidate; break; }
        }
        if (!manager) {
            manager = [NETunnelProviderManager new];
            NETunnelProviderProtocol *protocol = [NETunnelProviderProtocol new];
            protocol.providerBundleIdentifier = @"app.hive.xctrunner.loopback";
            protocol.serverAddress = @"This iPhone";
            manager.protocolConfiguration = protocol;
            manager.localizedDescription = @"Hive Phone Control";
        }
        manager.enabled = YES;
        [manager saveToPreferencesWithCompletionHandler:^(NSError *error) {
            if (error) { dispatch_async(dispatch_get_main_queue(), ^{ progress(@"Allow Hive’s VPN connection to start phone control."); completion(NO); }); return; }
            [manager loadFromPreferencesWithCompletionHandler:^(NSError *error) {
                NSError *startError = nil;
                if (!error && manager.connection.status != NEVPNStatusConnected) [manager.connection startVPNTunnelAndReturnError:&startError];
                if (error || startError) { dispatch_async(dispatch_get_main_queue(), ^{ progress(@"Hive couldn’t start its phone connection."); completion(NO); }); return; }
                dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
                    while (manager.connection.status != NEVPNStatusConnected && deadline.timeIntervalSinceNow > 0) [NSThread sleepForTimeInterval:0.1];
                    if (manager.connection.status != NEVPNStatusConnected) {
                        dispatch_async(dispatch_get_main_queue(), ^{ progress(@"Hive’s phone connection didn’t start."); completion(NO); }); return;
                    }
                    [self mount:identity progress:progress completion:completion];
                });
            }];
        }];
    }];
}
+ (void)mount:(NSURL *)identity progress:(void (^)(NSString *))progress completion:(void (^)(BOOL))completion {
    NSOperatingSystemVersion version = NSProcessInfo.processInfo.operatingSystemVersion;
    BOOL cryptex = version.majorVersion > 26 || (version.majorVersion == 26 && version.minorVersion >= 4);
    NSString *kind = cryptex ? @"Xcode_iOS_DDI_Cryptex" : @"Xcode_iOS_DDI_Personalized";
    // Pin one coherent asset bundle; cached files never mix revisions or formats.
    NSString *revision = @"a9ae4c1c47105d195d860badf04c0e2a835b99d8";
    NSURL *support = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *directory = [[[support URLByAppendingPathComponent:@"DDI"] URLByAppendingPathComponent:revision] URLByAppendingPathComponent:kind];
    NSError *error = nil;
    [NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error];
    if (error) { dispatch_async(dispatch_get_main_queue(), ^{ progress(@"Hive couldn’t save its phone control files."); completion(NO); }); return; }
    NSMutableArray<NSString *> *files = [@[@"BuildManifest.plist", @"Image.dmg", @"Image.dmg.trustcache"] mutableCopy];
    if (cryptex) [files addObjectsFromArray:@[@"Image.dmg.cryptex_info", @"Image.dmg.root_hash"]];
    dispatch_async(dispatch_get_main_queue(), ^{ progress(@"Preparing phone control…"); });
    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.timeoutIntervalForRequest = 60;
    configuration.timeoutIntervalForResource = 600;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
    BOOL downloaded = YES;
    for (NSString *name in files) {
        NSURL *destination = [directory URLByAppendingPathComponent:name];
        if ([NSFileManager.defaultManager fileExistsAtPath:destination.path]) continue;
        NSString *address = [NSString stringWithFormat:@"https://raw.githubusercontent.com/doronz88/DeveloperDiskImage/%@/PersonalizedImages/%@/%@", revision, kind, name];
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block BOOL saved = NO;
        NSURLSessionDownloadTask *task = [session downloadTaskWithURL:[NSURL URLWithString:address] completionHandler:^(NSURL *temporary, NSURLResponse *response, NSError *error) {
            if (!error && [(NSHTTPURLResponse *)response statusCode] == 200) {
                saved = [NSFileManager.defaultManager moveItemAtURL:temporary toURL:destination error:nil];
            }
            dispatch_semaphore_signal(ready);
        }];
        [task resume];
        dispatch_semaphore_wait(ready, DISPATCH_TIME_FOREVER);
        if (!saved) { downloaded = NO; break; }
    }
    [session finishTasksAndInvalidate];
    if (!downloaded) { dispatch_async(dispatch_get_main_queue(), ^{ progress(@"Hive couldn’t download its phone control files. Check the connection and reopen Hive."); completion(NO); }); return; }
    int result = hive_mount_ddi(pairingPort(), identity.path.fileSystemRepresentation, directory.path.fileSystemRepresentation, cryptex);
    dispatch_async(dispatch_get_main_queue(), ^{
        if (result) progress(@"Hive couldn’t prepare phone control. Reopen Hive to try again.");
        completion(result == 0);
    });
}
@end
