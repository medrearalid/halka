#!/usr/bin/env bash
# Drives two real Halka instances over the WebView2 DevTools protocol.
# usage: tools/e2e/run.sh   (after: cargo build --profile fastrel -p halka --features tauri/custom-protocol)
set -e
cd "$(dirname "$0")/../.."
out=$(mktemp -d)
exe=target/fastrel/halka.exe
run() { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$1 $3" "$exe" --profile "$2" >/dev/null 2>&1 & }
t=$(date +%s)
run 9301 "e2e-a-$t"; run 9302 "e2e-b-$t"
node tools/e2e/flow.mjs "$out" || true
taskkill //F //IM halka.exe >/dev/null 2>&1 || pkill halka || true
run 9301 "e2e-e-$t"; run 9302 "e2e-f-$t"
node tools/e2e/admin.mjs || true
taskkill //F //IM halka.exe >/dev/null 2>&1 || pkill halka || true
# --use-fake-ui-for-media-stream skips the screen picker for the sharer (test only)
run 9301 "e2e-c-$t" "--use-fake-ui-for-media-stream"; run 9302 "e2e-d-$t"
sleep 8; node tools/e2e/share.mjs "$out"
taskkill //F //IM halka.exe >/dev/null 2>&1 || pkill halka || true
echo "screenshots: $out"
