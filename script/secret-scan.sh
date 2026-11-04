#!/bin/sh
# Pre-push secret scan: reads git's pre-push lines on stdin and scans only the pushed commits
# that no remote-tracking ref has yet, so a release push scans a few commits, not the history.
# Merge commits carry no diff in `git log -p` and are not scanned.
set -eu

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "secret scan: gitleaks not found. Install v8.28.0 (see .gitleaks.toml), or push with --no-verify to skip every pre-push check." >&2
  exit 1
fi

tips=""
while read -r _ local_sha _ _; do
  case "$local_sha" in
    *[!0]*) tips="${tips:+$tips }$(git rev-parse "$local_sha^{commit}")" ;;
  esac
done
[ -n "$tips" ] || exit 0

# shellcheck disable=SC2086
count=$(git rev-list --count $tips --not --remotes)
if [ "$count" = 0 ]; then
  echo "secret scan: no new commits"
  exit 0
fi

root=$(git rev-parse --show-toplevel)
echo "secret scan: $count new commit(s)"
# Gitleaks exits 0 when its own `git log` fails, so an error line also stops the push.
status=0
output=$(gitleaks git "$root" --log-opts="$tips --not --remotes" --config "$root/.gitleaks.toml" \
  --redact --no-banner --no-color --verbose 2>&1) || status=$?
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  echo "secret scan: push stopped. Remove the secret from the commits, or mark a test value with a 'gitleaks:allow' comment." >&2
  exit 1
fi
if printf '%s\n' "$output" | grep -q ' ERR '; then
  echo "secret scan: gitleaks failed, push stopped." >&2
  exit 1
fi
