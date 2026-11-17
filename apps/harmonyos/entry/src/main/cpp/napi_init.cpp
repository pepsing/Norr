#include "napi/native_api.h"
#include "asset/asset_api.h"
#include <cstring>
#include <memory>
#include <string>

extern "C" char *norr_invoke(const char *request);
extern "C" void norr_free_result(char *value);

static Asset_Attr BlobAttribute(Asset_Tag tag, const void *data, size_t size)
{
    Asset_Attr attribute {};
    attribute.tag = tag;
    attribute.value.blob = {static_cast<uint32_t>(size), reinterpret_cast<uint8_t *>(const_cast<void *>(data))};
    return attribute;
}

static Asset_Attr NumberAttribute(Asset_Tag tag, uint32_t value)
{
    Asset_Attr attribute {};
    attribute.tag = tag;
    attribute.value.u32 = value;
    return attribute;
}

extern "C" int32_t norr_storage_key(const uint8_t *candidate, uint8_t *output)
{
    const std::string alias = "norr-credential-aes-gcm-v1";
    Asset_Attr query[] = {
        BlobAttribute(ASSET_TAG_ALIAS, alias.data(), alias.size()),
        NumberAttribute(ASSET_TAG_RETURN_TYPE, ASSET_RETURN_ALL)
    };
    Asset_ResultSet results {};
    int32_t status = OH_Asset_Query(query, 2, &results);
    if (status == ASSET_NOT_FOUND) {
        Asset_Attr attributes[] = {
            query[0], BlobAttribute(ASSET_TAG_SECRET, candidate, 32),
            NumberAttribute(ASSET_TAG_ACCESSIBILITY, ASSET_ACCESSIBILITY_DEVICE_UNLOCKED),
            NumberAttribute(ASSET_TAG_SYNC_TYPE, ASSET_SYNC_TYPE_NEVER),
            NumberAttribute(ASSET_TAG_CONFLICT_RESOLUTION, ASSET_CONFLICT_THROW_ERROR)
        };
        status = OH_Asset_Add(attributes, 5);
        if (status != ASSET_SUCCESS && status != ASSET_DUPLICATED) return status;
        status = OH_Asset_Query(query, 2, &results);
    }
    if (status != ASSET_SUCCESS) return status;
    Asset_Attr *secret = results.count == 1 ? OH_Asset_ParseAttr(&results.results[0], ASSET_TAG_SECRET) : nullptr;
    if (secret && secret->value.blob.size == 32) {
        std::memcpy(output, secret->value.blob.data, 32);
    } else {
        status = ASSET_DATA_CORRUPTED;
    }
    if (secret) {
        volatile uint8_t *bytes = secret->value.blob.data;
        for (uint32_t index = 0; index < secret->value.blob.size; ++index) bytes[index] = 0;
    }
    OH_Asset_FreeResultSet(&results);
    return status;
}

struct Request {
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    std::string input;
    char *output = nullptr;

    ~Request()
    {
        volatile char *bytes = input.data();
        for (size_t index = 0; index < input.size(); ++index) bytes[index] = 0;
        norr_free_result(output);
    }
};

static void Execute(napi_env, void *data)
{
    auto *request = static_cast<Request *>(data);
    request->output = norr_invoke(request->input.c_str());
}

static void Complete(napi_env env, napi_status status, void *data)
{
    std::unique_ptr<Request> request(static_cast<Request *>(data));
    napi_value result;
    if (status == napi_ok && request->output) {
        napi_create_string_utf8(env, request->output, NAPI_AUTO_LENGTH, &result);
        napi_resolve_deferred(env, request->deferred, result);
    } else {
        napi_value message;
        napi_create_string_utf8(env, "原生请求未完成，请重试", NAPI_AUTO_LENGTH, &message);
        napi_create_error(env, nullptr, message, &result);
        napi_reject_deferred(env, request->deferred, result);
    }
    napi_delete_async_work(env, request->work);
}

static napi_value Invoke(napi_env env, napi_callback_info info)
{
    napi_value argument;
    size_t count = 1;
    napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
    size_t length = 0;
    if (count != 1 || napi_get_value_string_utf8(env, argument, nullptr, 0, &length) != napi_ok || length > 2 * 1024 * 1024) {
        napi_throw_type_error(env, nullptr, "原生请求格式无效");
        return nullptr;
    }
    auto request = std::make_unique<Request>();
    request->input.resize(length + 1);
    napi_get_value_string_utf8(env, argument, request->input.data(), length + 1, &length);
    request->input.resize(length);
    napi_value promise;
    napi_create_promise(env, &request->deferred, &promise);
    napi_value name;
    napi_create_string_utf8(env, "Norr vehicle request", NAPI_AUTO_LENGTH, &name);
    napi_status status = napi_create_async_work(env, nullptr, name, Execute, Complete, request.get(), &request->work);
    if (status == napi_ok) status = napi_queue_async_work(env, request->work);
    if (status != napi_ok) {
        if (request->work) napi_delete_async_work(env, request->work);
        napi_value message;
        napi_value error;
        napi_create_string_utf8(env, "无法启动原生请求", NAPI_AUTO_LENGTH, &message);
        napi_create_error(env, nullptr, message, &error);
        napi_reject_deferred(env, request->deferred, error);
        return promise;
    }
    request.release();
    return promise;
}

static napi_value Initialize(napi_env env, napi_value exports)
{
    napi_property_descriptor methods[] = {
        {"invoke", nullptr, Invoke, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    napi_define_properties(env, exports, 1, methods);
    return exports;
}

static napi_module module = {1, 0, nullptr, Initialize, "entry", nullptr, {0}};

extern "C" __attribute__((constructor)) void RegisterEntryModule()
{
    napi_module_register(&module);
}
