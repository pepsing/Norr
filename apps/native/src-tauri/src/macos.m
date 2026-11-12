#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#import <ServiceManagement/ServiceManagement.h>

static void (*desktopCallback)(int, const char *);

@interface NorrNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation NorrNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completion {
    NSDictionary *info = response.notification.request.content.userInfo;
    NSData *data = [NSJSONSerialization dataWithJSONObject:info options:0 error:nil];
    NSString *payload = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (desktopCallback) desktopCallback(3, payload.UTF8String);
        completion();
    });
}
@end

void norr_desktop_initialize(void (*callback)(int, const char *)) {
    desktopCallback = callback;
    static NorrNotificationDelegate *delegate;
    delegate = [[NorrNotificationDelegate alloc] init];
    [UNUserNotificationCenter currentNotificationCenter].delegate = delegate;
    NSNotificationCenter *center = [NSWorkspace sharedWorkspace].notificationCenter;
    [center addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
        (void)note;
        callback(1, NULL);
    }];
    [center addObserverForName:NSWorkspaceDidWakeNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
        (void)note;
        callback(2, NULL);
    }];
}

int norr_login_status(void) {
    return (int)SMAppService.mainAppService.status;
}

char *norr_set_login(bool enabled) {
    @autoreleasepool {
        NSError *error = nil;
        SMAppService *service = SMAppService.mainAppService;
        if (enabled && (service.status == SMAppServiceStatusEnabled || service.status == SMAppServiceStatusRequiresApproval)) return NULL;
        if (!enabled && service.status == SMAppServiceStatusNotRegistered) return NULL;
        BOOL success = enabled ? [service registerAndReturnError:&error]
                               : [service unregisterAndReturnError:&error];
        return success ? NULL : strdup((error.localizedDescription ?: @"登录启动设置失败").UTF8String);
    }
}

int norr_notification_status(bool request) {
    @autoreleasepool {
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        dispatch_semaphore_t completed = dispatch_semaphore_create(0);
        __block NSInteger status = -1;
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            status = settings.authorizationStatus;
            dispatch_semaphore_signal(completed);
        }];
        dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
        if (request && status == UNAuthorizationStatusNotDetermined) {
            [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL granted, NSError *error) {
                status = error ? -1 : (granted ? UNAuthorizationStatusAuthorized : UNAuthorizationStatusDenied);
                dispatch_semaphore_signal(completed);
            }];
            dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
        }
        return (int)status;
    }
}

char *norr_post_notification(const char *payload) {
    @autoreleasepool {
        NSData *data = [[NSString stringWithUTF8String:payload] dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *notice = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if (!notice) return strdup("通知内容无效");
        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = notice[@"title"];
        content.body = notice[@"body"];
        content.threadIdentifier = [@"norr." stringByAppendingString:notice[@"vin"]];
        content.userInfo = @{@"vin":notice[@"vin"], @"page":notice[@"page"]};
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:notice[@"id"] content:content trigger:nil];
        dispatch_semaphore_t completed = dispatch_semaphore_create(0);
        __block char *result = NULL;
        [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request withCompletionHandler:^(NSError *error) {
            if (error) result = strdup(error.localizedDescription.UTF8String);
            dispatch_semaphore_signal(completed);
        }];
        dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
        return result;
    }
}

bool norr_authenticate(void) {
    @autoreleasepool {
        LAContext *context = [[LAContext alloc] init];
        NSError *error = nil;
        if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
            return false;
        }
        dispatch_semaphore_t completed = dispatch_semaphore_create(0);
        __block BOOL authorized = NO;
        [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
                localizedReason:@"确认 Norr 的车辆操作"
                          reply:^(BOOL success, NSError *evaluationError) {
            (void)evaluationError;
            authorized = success;
            dispatch_semaphore_signal(completed);
        }];
        dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
        return authorized;
    }
}

char *norr_save_path(const char *name) {
    @autoreleasepool {
        NSString *filename = [NSString stringWithUTF8String:name];
        __block char *result = NULL;
        dispatch_sync(dispatch_get_main_queue(), ^{
            NSSavePanel *panel = [NSSavePanel savePanel];
            panel.nameFieldStringValue = filename;
            panel.canCreateDirectories = YES;
            if ([panel runModal] == NSModalResponseOK) {
                result = strdup(panel.URL.path.UTF8String);
            }
        });
        return result;
    }
}

void norr_free_string(char *value) { free(value); }

char *norr_open_path(void) {
    @autoreleasepool {
        __block char *result = NULL;
        dispatch_sync(dispatch_get_main_queue(), ^{
            NSOpenPanel *panel = [NSOpenPanel openPanel];
            panel.title = @"恢复 Norr 历史备份";
            panel.canChooseFiles = YES;
            panel.canChooseDirectories = NO;
            panel.allowsMultipleSelection = NO;
            if ([panel runModal] == NSModalResponseOK) {
                result = strdup(panel.URL.path.UTF8String);
            }
        });
        return result;
    }
}
