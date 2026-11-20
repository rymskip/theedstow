#!/usr/bin/env bash
# Empties a throwaway home trash holding an item whose file is missing, a
# dangling symlink and a plain file, which upstream's 2.0.0 panics on. Only
# items trashed from the sandbox are matched, so no real trash is touched.
set -euo pipefail
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT
trash_dir="$sandbox/data/Trash"
origin="$sandbox/origin"
mkdir -p "$trash_dir/files" "$trash_dir/info" "$origin"

seed_info() {
  printf '[Trash Info]\nPath=%s/%s\nDeletionDate=2026-11-20T12:00:00\n' "$origin" "$1" \
    >"$trash_dir/info/$1.trashinfo"
}
seed_info gone
seed_info dead
ln -s "$sandbox/nowhere" "$trash_dir/files/dead"
seed_info kept
echo content >"$trash_dir/files/kept"

XDG_DATA_HOME="$sandbox/data" trashy empty --directory "$origin" --force

left="$(ls -A "$trash_dir/files" "$trash_dir/info" | grep -v -e '^$' -e ':$' || true)"
if [ -n "$left" ]; then
  echo "items left in the trash: $left" >&2
  exit 1
fi
