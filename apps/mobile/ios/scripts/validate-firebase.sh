#!/bin/sh
set -eu

# Debug can run without push credentials during development. A distributable
# app must contain the Firebase client for its own bundle, never another app.
[ "${CONFIGURATION:-}" = "Release" ] || exit 0

config="${SRCROOT}/Fagoo/Resources/GoogleService-Info.plist"
fail() { printf '%s\n' "error: $1" >&2; exit 1; }
[ -f "$config" ] || fail "Release requires Fagoo/Resources/GoogleService-Info.plist."

read_value() { /usr/libexec/PlistBuddy -c "Print $1" "$config" 2>/dev/null || true; }
bundle=$(read_value BUNDLE_ID)
[ -n "${PRODUCT_BUNDLE_IDENTIFIER:-}" ] && [ "$bundle" = "$PRODUCT_BUNDLE_IDENTIFIER" ] ||
  fail "The Firebase client must match PRODUCT_BUNDLE_IDENTIFIER."
[ -n "$(read_value GOOGLE_APP_ID)" ] && [ -n "$(read_value PROJECT_ID)" ] ||
  fail "The Firebase client is missing its app or project identifier."
[ "$(read_value IS_GCM_ENABLED)" = "true" ] ||
  fail "The Firebase client must enable Cloud Messaging."
