#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

// Hive Phone's link to the board (phone/ios/build.sh). It dials out to the board over one
// WebSocket and passes the board's WebDriverAgent calls to WDA on this phone (127.0.0.1:8100) and
// nowhere else; nothing can reach in.
//
// Pairing: the dashboard's "Connect an iPhone" copies "hive-phone:" + base64url(JSON {url, token}).
// While Hive Phone isn't connected (unpaired, refused, or its Hive is gone or moved) it watches the
// clipboard (the change count, which asks nothing) and reads a new copy once; a valid pairing is kept
// in Documents/phone-relay.json and the clipboard is cleared. A connected phone never reads it.

// The other end: Hive's server, phone/src/link.rs.
static NSInteger const HivePhoneProtocol = 1;
static NSString *const HivePairingPrefix = @"hive-phone:";

@interface PhoneRelay : NSObject
@property(nonatomic,strong) NSURLSession *session;
@property(nonatomic,strong) NSURLSessionWebSocketTask *socket;
@property(nonatomic,strong) NSDictionary *config;
@property(nonatomic,strong) dispatch_source_t heartbeat;
@property(nonatomic,strong) dispatch_source_t watch;
@property(nonatomic,assign) BOOL stopped;
@property(nonatomic,assign) BOOL refused;
@property(nonatomic,assign) BOOL failing;
@property(nonatomic,assign) BOOL looking;
@property(nonatomic,assign) NSInteger seenClipboard;
@property(nonatomic,assign) NSUInteger retry;
- (void)start;
- (void)stop;
@end

@implementation PhoneRelay

+ (NSString *)savedPath {
  return [NSHomeDirectory() stringByAppendingPathComponent:@"Documents/phone-relay.json"];
}

+ (NSDictionary *)checked:(id)config {
  if(![config isKindOfClass:NSDictionary.class])return nil;
  NSString *endpoint=config[@"url"],*token=config[@"token"];
  if(![endpoint isKindOfClass:NSString.class] || ![token isKindOfClass:NSString.class] || token.length<40 || token.length>512)return nil;
  NSURL *url=[NSURL URLWithString:endpoint];
  if(![url.scheme isEqualToString:@"wss"] || !url.host.length || ![url.path hasSuffix:@"/device"])return nil;
  return @{@"url":endpoint,@"token":token};
}

+ (NSDictionary *)saved {
  NSData *data=[NSData dataWithContentsOfFile:[self savedPath]];
  return data?[self checked:[NSJSONSerialization JSONObjectWithData:data options:(NSJSONReadingOptions)0 error:nil]]:nil;
}

+ (NSDictionary *)pairingFrom:(NSString *)text {
  text=[text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if(![text hasPrefix:HivePairingPrefix] || text.length>4096)return nil;
  NSString *b64=[[[text substringFromIndex:HivePairingPrefix.length]
    stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
  while(b64.length%4)b64=[b64 stringByAppendingString:@"="];
  NSData *data=[[NSData alloc] initWithBase64EncodedString:b64 options:(NSDataBase64DecodingOptions)0];
  return data?[self checked:[NSJSONSerialization JSONObjectWithData:data options:(NSJSONReadingOptions)0 error:nil]]:nil;
}

+ (NSString *)hiveVersion {
  NSString *v=[[NSBundle bundleForClass:self] objectForInfoDictionaryKey:@"HiveVersion"]?:[NSBundle.mainBundle objectForInfoDictionaryKey:@"HiveVersion"];
  return [v isKindOfClass:NSString.class] && v.length?v:@"dev";
}

- (void)start {
  self.stopped=NO;
  self.seenClipboard=-1;
  NSURLSessionConfiguration *cfg=[NSURLSessionConfiguration ephemeralSessionConfiguration];
  cfg.timeoutIntervalForRequest=25;
  cfg.timeoutIntervalForResource=30;
  self.session=[NSURLSession sessionWithConfiguration:cfg];
  self.config=[PhoneRelay saved];
  if(self.config)[self connect];
  __weak PhoneRelay *weakSelf=self;
  // Unpaired or refused: look at the clipboard whenever it changes.
  self.watch=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());
  dispatch_source_set_timer(self.watch,DISPATCH_TIME_NOW,2*NSEC_PER_SEC,NSEC_PER_SEC/2);
  dispatch_source_set_event_handler(self.watch,^{[weakSelf lookForPairing];});
  dispatch_resume(self.watch);
  self.heartbeat=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_main_queue());
  dispatch_source_set_timer(self.heartbeat,dispatch_time(DISPATCH_TIME_NOW,15*NSEC_PER_SEC),15*NSEC_PER_SEC,NSEC_PER_SEC);
  dispatch_source_set_event_handler(self.heartbeat,^{
    PhoneRelay *strongSelf=weakSelf;
    NSURLSessionWebSocketTask *ws=strongSelf.socket;
    [ws sendPingWithPongReceiveHandler:^(NSError *err){
      dispatch_async(dispatch_get_main_queue(),^{PhoneRelay *owner=weakSelf;if(err)[owner reconnect:ws];else{owner.retry=0;owner.failing=NO;}});
    }];
  });
  dispatch_resume(self.heartbeat);
}

- (void)lookForPairing {
  if(self.stopped || self.looking || (self.config && !self.failing))return;
  UIPasteboard *board=UIPasteboard.generalPasteboard;
  NSInteger count=board.changeCount;
  if(count==self.seenClipboard)return;
  self.seenClipboard=count;
  if(!board.hasStrings)return;
  self.looking=YES;
  __weak PhoneRelay *weakSelf=self;
  // Reading may show iOS's paste prompt, which blocks the reader until it's answered.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
    NSString *text=UIPasteboard.generalPasteboard.string;
    NSDictionary *found=text?[PhoneRelay pairingFrom:text]:nil;
    if(found){
      NSData *data=[NSJSONSerialization dataWithJSONObject:found options:(NSJSONWritingOptions)0 error:nil];
      [data writeToFile:[PhoneRelay savedPath] options:(NSDataWritingOptions)(NSDataWritingAtomic|NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication) error:nil];
      UIPasteboard.generalPasteboard.items=@[];
    }
    dispatch_async(dispatch_get_main_queue(),^{
      PhoneRelay *strongSelf=weakSelf;
      if(!strongSelf)return;
      strongSelf.looking=NO;
      if(!found || strongSelf.stopped)return;
      strongSelf.config=found;
      strongSelf.refused=NO;
      strongSelf.failing=NO;
      strongSelf.retry=0;
      NSURLSessionWebSocketTask *old=strongSelf.socket;
      strongSelf.socket=nil;
      [old cancelWithCloseCode:NSURLSessionWebSocketCloseCodeGoingAway reason:nil];
      [strongSelf connect];
    });
  });
}

- (void)connect {
  if(self.stopped)return;
  NSString *endpoint=self.config[@"url"],*token=self.config[@"token"];
  if(!endpoint || !token)return;
  NSURL *url=[NSURL URLWithString:endpoint];
  if(!url)return;
  NSMutableURLRequest *r=[NSMutableURLRequest requestWithURL:url];
  [r setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  [r setValue:@"phone:iphone" forHTTPHeaderField:@"X-Hive-Node"];
  [r setValue:[PhoneRelay hiveVersion] forHTTPHeaderField:@"X-Hive-Version"];
  [r setValue:[NSString stringWithFormat:@"%ld",(long)HivePhoneProtocol] forHTTPHeaderField:@"X-Hive-Protocol"];
  self.socket=[self.session webSocketTaskWithRequest:r];
  self.socket.maximumMessageSize=2*1024*1024;
  [self.socket resume];
  [self receive:self.socket];
}

- (void)reconnect:(NSURLSessionWebSocketTask *)ws {
  if(self.stopped || self.socket!=ws)return;
  self.socket=nil;
  self.failing=YES;
  NSInteger status=[ws.response isKindOfClass:NSHTTPURLResponse.class]?((NSHTTPURLResponse *)ws.response).statusCode:0;
  // The board turned this pairing down: take a new one from the clipboard when it comes.
  if(status==401 || status==403){self.refused=YES;self.seenClipboard=-1;}
  [ws cancelWithCloseCode:NSURLSessionWebSocketCloseCodeGoingAway reason:nil];
  NSUInteger delay=self.refused?60:MIN(30,(NSUInteger)1<<MIN(self.retry++,5));
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)delay*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(!self.stopped && !self.socket)[self connect];});
}

- (void)receive:(NSURLSessionWebSocketTask *)ws {
  __weak PhoneRelay *weakSelf=self;
  [ws receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message,NSError *error){
    dispatch_async(dispatch_get_main_queue(),^{
      PhoneRelay *strongSelf=weakSelf;
      if(!strongSelf || strongSelf.stopped || ws!=strongSelf.socket)return;
      if(error){[strongSelf reconnect:ws];return;}
      strongSelf.refused=NO;
      strongSelf.failing=NO;
      NSData *data=message.type==NSURLSessionWebSocketMessageTypeString?[message.string dataUsingEncoding:NSUTF8StringEncoding]:message.data;
      NSDictionary *command=data?[NSJSONSerialization JSONObjectWithData:data options:(NSJSONReadingOptions)0 error:nil]:nil;
      if([command isKindOfClass:NSDictionary.class])[strongSelf forward:command socket:ws];
      [strongSelf receive:ws];
    });
  }];
}

- (void)forward:(NSDictionary *)command socket:(NSURLSessionWebSocketTask *)ws {
  NSString *path=command[@"path"],*method=command[@"method"],*identifier=command[@"id"],*body=command[@"body"];
  if(![path isKindOfClass:NSString.class] || ![method isKindOfClass:NSString.class] || ![identifier isKindOfClass:NSString.class] || ![body isKindOfClass:NSString.class])return;
  NSRegularExpression *routes=[NSRegularExpression regularExpressionWithPattern:@"^/(status|screenshot|session|wda)(/|\\?|$)" options:(NSRegularExpressionOptions)0 error:nil];
  if(![routes firstMatchInString:path options:(NSMatchingOptions)0 range:NSMakeRange(0,path.length)] || [path containsString:@".."] || [path containsString:@"%"] || [path containsString:@"\\"] || ![@[@"GET",@"POST",@"DELETE"] containsObject:method])return;
  NSURL *url=[NSURL URLWithString:[@"http://127.0.0.1:8100" stringByAppendingString:path]];
  if(![url.host isEqualToString:@"127.0.0.1"] || url.port.integerValue!=8100)return;
  NSMutableURLRequest *r=[NSMutableURLRequest requestWithURL:url];
  r.HTTPMethod=method;
  [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  if(body.length)r.HTTPBody=[body dataUsingEncoding:NSUTF8StringEncoding];
  __weak PhoneRelay *weakSelf=self;
  [[self.session dataTaskWithRequest:r completionHandler:^(NSData *data,NSURLResponse *response,NSError *error){
    NSInteger status=error?502:((NSHTTPURLResponse *)response).statusCode;
    NSString *text=error?@"{\"error\":\"local WDA unavailable\"}":[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if(data.length>12*1024*1024){status=502;text=@"{\"error\":\"response too large\"}";}
    NSDictionary *result=@{@"id":identifier,@"status":@(status),@"body":text?:@""};
    NSData *encoded=[NSJSONSerialization dataWithJSONObject:result options:(NSJSONWritingOptions)0 error:nil];
    NSString *str=[[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding];
    [ws sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:str] completionHandler:^(NSError *err){
      if(err)dispatch_async(dispatch_get_main_queue(),^{[weakSelf reconnect:ws];});
    }];
  }] resume];
}

- (void)stop {
  self.stopped=YES;
  if(self.heartbeat){dispatch_source_cancel(self.heartbeat);self.heartbeat=nil;}
  if(self.watch){dispatch_source_cancel(self.watch);self.watch=nil;}
  [self.socket cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
  [self.session invalidateAndCancel];
  self.socket=nil;self.session=nil;
}
@end
