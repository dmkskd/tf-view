# Justfile for tf plan view
# Run `just` or `just --list` to see available commands

set shell := ["bash", "-cu"]

# Default recipe: list available commands
default:
    @just --list

# Start Vite development server with hot module replacement (HMR)
dev port="3000":
    npx vite src --port {{port}}

# Build the single self-contained HTML asset (dist/index.html)
build: typecheck
    node scripts/build-single-html.js

# Run the entire test suite and regression baselines
test: typecheck build test-unit test-boot test-render test-links test-csp test-providers test-pure test-parse test-layout
    @echo "✅ All tests and regression baselines passed!"

# Run unit assertions (optional suite filter, e.g. `just test-unit placement`)
test-unit suite="":
    node tools/test.js {{suite}}

# Run headless DOM boot check
test-boot:
    node tools/check-boot.js

# Run headless DOM interactive render check
test-render:
    node tools/check-render.js

# Check the console-link guard against hostile plans
test-links:
    node tools/check-links.js

# Check the built page's Content-Security-Policy is strict and matches its script
test-csp:
    node tools/check-csp.js

# Check provider folders import only the SDK and stay away from the page, network and eval
test-providers:
    node tools/check-providers.js

# Verify pure functions against baseline
test-pure:
    node tools/check-pure.js | diff tools/baseline/check-pure.txt -

# Verify parser and validation messages against baseline
test-parse:
    node tools/check-parse.js | diff tools/baseline/check-parse.txt -

# Verify layout coordinates and hierarchy against baseline
test-layout:
    node tools/check-layout.js | diff tools/baseline/check-layout.txt -

# Re-record all regression baselines when intentional changes are made
record-baselines:
    node tools/check-pure.js > tools/baseline/check-pure.txt
    node tools/check-parse.js > tools/baseline/check-parse.txt
    node tools/check-layout.js > tools/baseline/check-layout.txt
    @echo "✅ All baselines re-recorded in tools/baseline/"

# Run TypeScript type verification
typecheck:
    npx tsc --noEmit
    @echo "✅ TypeScript type check passed with 0 errors!"

# Validate TypeScript types and script syntax
check: typecheck
    @echo "Checking script syntax..."
    @for f in `find scripts tools -name "*.js"`; do node --check "$f" || exit 1; done
    @echo "✅ All files passed syntax verification!"

# Build and open the self-contained app directly in the default browser
open: build
    @open dist/index.html 2>/dev/null || xdg-open dist/index.html 2>/dev/null

# Re-extract clean modular files from pristine index.html
split:
    node scripts/split-all.js

# Clean temporary build artifacts and caches
clean:
    rm -rf dist/ .vite/ cli/target/
    @echo "✅ Cleaned build artifacts!"

# Build the standalone Rust CLI binary (embeds dist/index.html)
cli-build: build
    cd cli && cargo build --release
    @echo "✅ Built release binary at cli/target/release/tfview"

# Install tfview binary locally to ~/.cargo/bin (immediately available in PATH)
cli-install: build
    cargo install --path cli --force
    @echo "✅ Installed tfview to ~/.cargo/bin/tfview"

