#!/bin/bash
# Refuse to pack/publish from a dirty tree. The Jun-Jul 2026 five-week
# git/artifact drift shipped a month of uncommitted code via npm pack.
# Untracked .tgz packs are the shipping record and are allowed.
dirt=$(git status --porcelain | grep -v '\.tgz$')
if [ -n "$dirt" ]; then
  echo "ERROR: working tree is dirty — commit before pack/publish:" >&2
  echo "$dirt" >&2
  exit 1
fi
