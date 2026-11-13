cmake_minimum_required(VERSION 3.16)
project(aegis_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(aegis_core SHARED
    src/c_api.cpp
    src/hnsw_cache.cpp
    src/guardrail.cpp
)
target_include_directories(aegis_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_definitions(aegis_core PRIVATE AEGIS_CORE_EXPORTS)
if (MSVC)
    target_compile_options(aegis_core PRIVATE /O2 /W4)
else()
    target_compile_options(aegis_core PRIVATE -O3 -Wall -Wextra -pthread)
    target_link_libraries(aegis_core PRIVATE pthread)
endif()

add_executable(aegis_tests
    tests/cpp_tests.cpp
    src/c_api.cpp
    src/hnsw_cache.cpp
    src/guardrail.cpp
)
target_include_directories(aegis_tests PRIVATE include src)
target_compile_definitions(aegis_tests PRIVATE AEGIS_CORE_EXPORTS)
if (NOT MSVC)
    target_compile_options(aegis_tests PRIVATE -O2 -pthread)
    target_link_libraries(aegis_tests PRIVATE pthread)
endif()

add_executable(aegis_bench
    bench/cpp_bench.cpp
    src/hnsw_cache.cpp
    src/guardrail.cpp
)
target_include_directories(aegis_bench PRIVATE include src)
if (NOT MSVC)
    target_compile_options(aegis_bench PRIVATE -O3 -pthread)
    target_link_libraries(aegis_bench PRIVATE pthread)
endif()
