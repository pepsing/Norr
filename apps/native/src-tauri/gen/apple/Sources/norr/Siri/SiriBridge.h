#ifndef NORR_SIRI_BRIDGE_H
#define NORR_SIRI_BRIDGE_H

void * _Nonnull norr_siri_cancellation_new(void);
void norr_siri_cancel(const void * _Nonnull cancellation);
void norr_siri_cancellation_free(void * _Nonnull cancellation);
void norr_siri_run(const char * _Nonnull request, const void * _Nonnull cancellation,
    void * _Nonnull context, void (* _Nonnull complete)(void * _Nonnull, const char * _Nullable));

#endif
