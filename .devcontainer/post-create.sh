#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential python3 pkg-config xvfb \
  libgtk-3-0 libnss3 libasound2 libxss1 libgbm1 libxshmfence1 \
  libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxrandr2
sudo rm -rf /var/lib/apt/lists/*

npm install

echo
printf '%s\n' \
  'Kangentic development environment ready.' \
  'Use: npm run typecheck && npm run lint && npm run test:unit' \
  'Electron UI remains a desktop app; Codespaces is for development/build/test.'
