#!/usr/bin/env bash
set -euo pipefail

: "${WASI_SDK_PATH:?Set WASI_SDK_PATH to the wasi-sdk 29 installation}"
cd "$(dirname "$0")/../native/engine"

export CC_wasm32_wasip1="$WASI_SDK_PATH/bin/clang"
export AR_wasm32_wasip1="$WASI_SDK_PATH/bin/llvm-ar"
export CARGO_TARGET_WASM32_WASIP1_LINKER="$CC_wasm32_wasip1"
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-self-contained=no -C link-arg=-lwasi-emulated-mman -C link-arg=-lwasi-emulated-getpid -C link-arg=-lwasi-emulated-signal -C link-arg=-lwasi-emulated-process-clocks"
# The Node lease owns the private output. Published bases are immutable.
export LIBSQLITE3_FLAGS='SQLITE_DEFAULT_UNIX_VFS="unix-none" SQLITE_TEMP_STORE=3'
cargo build --locked --release --target wasm32-wasip1
