#!/usr/bin/env bash
# Build capo-dsp → ../wasm/capo_dsp.wasm
# Thư mục target để ngoài extension (Chrome nạp toàn bộ thư mục extension).
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/capo-dsp-target}"

case "${1:-}" in
  test) exec cargo test --release ;;
  tune) exec cargo run --release --example tune ;;
esac

cargo build --release --target wasm32-unknown-unknown
mkdir -p ../wasm
cp "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/capo_dsp.wasm" ../wasm/capo_dsp.wasm
ls -l ../wasm/capo_dsp.wasm
