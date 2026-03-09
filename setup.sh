#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Installing APT packages..."
sudo apt-get update -qq
xargs -a apt-packages.txt sudo apt-get install -y -qq

echo "Done."
