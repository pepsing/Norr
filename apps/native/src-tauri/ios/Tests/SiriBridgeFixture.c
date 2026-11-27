#include "../../gen/apple/Sources/norr/Siri/SiriBridge.h"
#include <dispatch/dispatch.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

void *norr_siri_cancellation_new(void) {
    atomic_bool *cancelled = malloc(sizeof(*cancelled));
    if (!cancelled) abort();
    atomic_init(cancelled, false);
    return cancelled;
}

void norr_siri_cancel(const void *cancellation) {
    atomic_store((atomic_bool *)cancellation, true);
}

void norr_siri_cancellation_free(void *cancellation) {
    free(cancellation);
}

void norr_siri_run(const char *request, const void *cancellation, void *context,
                 void (*complete)(void *, const char *)) {
    if (strstr(request, "\"vehicles\"")) {
        complete(context, "{\"status\":\"vehicles\",\"preferred\":\"fixture\",\"vehicles\":[{\"id\":\"fixture\",\"name\":\"Test vehicle\"}]}");
    } else if (strstr(request, "\"energy\"") && strstr(request, "\"fixture\"")) {
        complete(context, "{\"status\":\"reading\",\"reading\":{\"value\":{\"percent\":0},\"reportedAt\":1000}}");
    } else if (strstr(request, "\"widgetRefresh\"") && strstr(request, "\"fixture\"")) {
        complete(context, "{\"status\":\"refreshed\"}");
    } else if (strstr(request, "\"lockState\"")) {
        complete(context, "{\"status\":\"error\",\"message\":\"请先在 Norr 登录\"}");
    } else if (strstr(request, "\"fixture\"") &&
               (strstr(request, "\"unlock\"") || strstr(request, "\"windowsOpen\"") ||
                strstr(request, "\"windowsClose\"") ||
                strstr(request, "\"tailgateOpen\"") || strstr(request, "\"tailgateClose\""))) {
        complete(context, "{\"status\":\"confirmed\"}");
    } else if (strstr(request, "\"climateStart\"")) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC),
                       dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
            bool cancelled = atomic_load((const atomic_bool *)cancellation);
            complete(context, cancelled ? "{\"status\":\"pending\"}" : NULL);
        });
    } else {
        complete(context, NULL);
    }
}
