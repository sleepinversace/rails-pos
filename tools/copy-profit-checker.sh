#!/bin/sh
# Copies Rails Profit checker (Desktop\Rails - Charts) into profit/ — the copy that
# opens inside Rails POS (Reports → Profit checker, a paid add-on).
# Run from the Rails POS folder after changing the Profit checker:
#   sh tools/copy-profit-checker.sh
# then bump CACHE_VERSION in sw.js (and add a CHANGELOG entry) as usual.
set -e
SRC="${1:-../Rails - Charts}"
mkdir -p profit/icons
cp "$SRC/app.js" "$SRC/calculations.js" "$SRC/importers.js" "$SRC/till-insights.js" "$SRC/styles.css" profit/
cp "$SRC/icons/icon.svg" profit/icons/
# index.html: no install/offline files of its own (the till's service worker keeps it
# offline), no sample data, and it only opens from inside Rails POS (PC_REQUIRE_HOST).
sed -e '/rel="manifest"/d' -e '/apple-touch-icon/d' -e '/sample-data.js/d' \
    -e 's|<link rel="stylesheet" href="styles.css">|<link rel="stylesheet" href="styles.css">\n  <script>window.PC_REQUIRE_HOST = true;</script>|' \
    "$SRC/index.html" > profit/index.html
echo "Copied. Now bump CACHE_VERSION in sw.js."
