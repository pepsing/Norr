#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

@interface NorrVerificationController : NSObject <WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate>
@property NSPanel *panel;
@property WKWebView *webView;
@property NSTextField *status;
@property NSButton *retry;
@property BOOL finished;
@property (copy) void (^completion)(NSString *);
- (void)present;
- (void)finish:(NSString *)result;
@end

@implementation NorrVerificationController
- (void)present {
    self.panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 520, 340)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
        backing:NSBackingStoreBuffered defer:NO];
    self.panel.title = @"Polestar 手机验证";
    self.panel.delegate = self;
    self.panel.releasedWhenClosed = NO;
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    for (NSString *name in @[@"chinaVerification", @"dispatch"]) {
        [configuration.userContentController addScriptMessageHandler:self name:name];
    }
    NSString *bridge = @"window.chromium={postMessage:function(message){window.webkit.messageHandlers.chinaVerification.postMessage(String(message));}};";
    [configuration.userContentController addUserScript:[[WKUserScript alloc]
        initWithSource:bridge injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    self.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(20, 78, 480, 240) configuration:configuration];
    self.webView.navigationDelegate = self;
    [self.panel.contentView addSubview:self.webView];
    self.status = [NSTextField wrappingLabelWithString:@"正在加载 Polestar 验证页面…"];
    self.status.frame = NSMakeRect(20, 40, 480, 34);
    self.status.font = [NSFont systemFontOfSize:13];
    [self.panel.contentView addSubview:self.status];
    NSButton *cancel = [NSButton buttonWithTitle:@"取消" target:self action:@selector(cancel:)];
    cancel.frame = NSMakeRect(416, 8, 84, 28);
    cancel.keyEquivalent = @"\e";
    [self.panel.contentView addSubview:cancel];
    self.retry = [NSButton buttonWithTitle:@"重新加载" target:self action:@selector(reload:)];
    self.retry.frame = NSMakeRect(300, 8, 110, 28);
    [self.panel.contentView addSubview:self.retry];
    [self reload:nil];
    NSWindow *parent = NSApp.mainWindow;
    if (parent) {
        [parent beginSheet:self.panel completionHandler:nil];
    } else {
        [self.panel center];
        [self.panel makeKeyAndOrderFront:nil];
    }
    __weak NorrVerificationController *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        [weakSelf finish:@"{\"error\":\"验证已超时，请重新获取验证码\"}"];
    });
}

- (void)reload:(id)sender {
    (void)sender;
    self.status.stringValue = @"正在加载 Polestar 验证页面…";
    self.retry.enabled = NO;
    [self.webView loadRequest:[NSURLRequest requestWithURL:
        [NSURL URLWithString:@"https://h5.app.polestar-auto.com/account-components/auth-slider/index.html"]]];
}

- (void)cancel:(id)sender {
    (void)sender;
    [self finish:@"null"];
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    (void)sender;
    [self finish:@"null"];
    return NO;
}

- (void)finish:(NSString *)result {
    if (self.finished) return;
    self.finished = YES;
    [self.webView stopLoading];
    self.webView.navigationDelegate = nil;
    for (NSString *name in @[@"chinaVerification", @"dispatch"]) {
        [self.webView.configuration.userContentController removeScriptMessageHandlerForName:name];
    }
    if (self.panel.sheetParent) [self.panel.sheetParent endSheet:self.panel];
    [self.panel orderOut:nil];
    self.panel.delegate = nil;
    void (^completion)(NSString *) = self.completion;
    self.completion = nil;
    completion(result);
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)controller;
    WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
    if (self.finished || !message.frameInfo.isMainFrame ||
        ![origin.protocol isEqualToString:@"https"] ||
        ![origin.host isEqualToString:@"h5.app.polestar-auto.com"] ||
        (origin.port != 0 && origin.port != 443) || ![message.body isKindOfClass:NSString.class]) return;
    NSString *text = message.body;
    if ([text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 16384) return;
    NSString *json = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (![json hasPrefix:@"{"]) {
        NSURLComponents *url = [NSURLComponents componentsWithString:text];
        if (![url.scheme isEqualToString:@"polestar"] || ![url.host isEqualToString:@"webview"] ||
            ![url.path isEqualToString:@"/autoAccount"] || url.user || url.password || url.port || url.fragment) return;
        NSRange marker = [text rangeOfString:@"?data="];
        if (marker.location == NSNotFound) return;
        json = [[text substringFromIndex:NSMaxRange(marker)] stringByRemovingPercentEncoding];
    }
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    id object = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![object isKindOfClass:NSDictionary.class]) return;
    NSMutableDictionary *verified = [NSMutableDictionary dictionary];
    for (NSString *key in @[@"sessionId", @"sig", @"token"]) {
        id value = object[key];
        if (![value isKindOfClass:NSString.class] ||
            [[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] length] == 0) {
            self.status.stringValue = @"验证结果无效，请重新加载后再试。";
            self.retry.enabled = YES;
            return;
        }
        verified[key] = value;
    }
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:verified options:0 error:nil];
    [self finish:[[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding]];
}

- (void)webView:(WKWebView *)view decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    (void)view;
    NSURL *url = action.request.URL;
    BOOL https = [url.scheme isEqualToString:@"https"];
    BOOL subframe = action.targetFrame && !action.targetFrame.isMainFrame;
    BOOL allowed = https && (subframe ||
        ([url.host isEqualToString:@"h5.app.polestar-auto.com"] &&
         [url.path isEqualToString:@"/account-components/auth-slider/index.html"] &&
         !url.user && !url.password && (!url.port || url.port.integerValue == 443)));
    decisionHandler(allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view; (void)navigation;
    self.status.stringValue = @"完成验证后会向所填手机号发送短信。";
    self.retry.enabled = YES;
}

- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)view; (void)navigation;
    if (error.code == NSURLErrorCancelled || self.finished) return;
    self.status.stringValue = @"验证页面加载失败，请检查网络后重新加载。";
    self.retry.enabled = YES;
}

- (void)webView:(WKWebView *)view didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self webView:view didFailProvisionalNavigation:navigation withError:error];
}
@end

char *norr_china_verification(void) {
    @autoreleasepool {
        dispatch_semaphore_t completed = dispatch_semaphore_create(0);
        __block char *result = NULL;
        __block NorrVerificationController *controller;
        dispatch_async(dispatch_get_main_queue(), ^{
            controller = [[NorrVerificationController alloc] init];
            controller.completion = ^(NSString *value) {
                result = strdup((value ?: @"null").UTF8String);
                controller = nil;
                dispatch_semaphore_signal(completed);
            };
            [controller present];
        });
        dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
        return result;
    }
}
