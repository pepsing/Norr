#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

extern "C" void norr_widget_launch_url(const char *url);

static void captureSceneLaunchURLs(UIApplication *application) {
    SEL selector = @selector(application:configurationForConnectingSceneSession:options:);
    Method method = class_getInstanceMethod([application.delegate class], selector);
    if (!method) return;
    using ConfigureScene = UISceneConfiguration *(*)(id, SEL, UIApplication *, UISceneSession *, UISceneConnectionOptions *);
    ConfigureScene original = (ConfigureScene)method_getImplementation(method);
    // Tao 0.37 drops the first scene's URL contexts before emitting Opened events.
    IMP implementation = imp_implementationWithBlock(^UISceneConfiguration *(
        id delegate, UIApplication *app, UISceneSession *session, UISceneConnectionOptions *options
    ) {
        for (UIOpenURLContext *context in options.URLContexts) {
            norr_widget_launch_url(context.URL.absoluteString.UTF8String);
        }
        return original(delegate, selector, app, session, options);
    });
    method_setImplementation(method, implementation);
}

int main(int argc, char * argv[]) {
    @autoreleasepool {
        [[NSNotificationCenter defaultCenter]
            addObserverForName:UIApplicationDidFinishLaunchingNotification
            object:nil queue:nil usingBlock:^(NSNotification *notification) {
                captureSceneLaunchURLs(notification.object);
                NSURL *url = notification.userInfo[UIApplicationLaunchOptionsURLKey];
                if (url) norr_widget_launch_url(url.absoluteString.UTF8String);
            }];
        ffi::start_app();
    }
    return 0;
}
