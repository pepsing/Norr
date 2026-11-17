cmake_minimum_required(VERSION 3.5.0)
project(norr_harmonyos)
set(CMAKE_CXX_STANDARD 17)

get_filename_component(NORR_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../.." ABSOLUTE)
add_library(norr_rust STATIC IMPORTED)
set_target_properties(norr_rust PROPERTIES
    IMPORTED_LOCATION "${NORR_ROOT}/target/aarch64-unknown-linux-ohos/release/libnorr_harmonyos.a")

add_library(entry SHARED napi_init.cpp)
target_link_libraries(entry PRIVATE norr_rust libace_napi.z.so libasset_ndk.z.so dl m)
