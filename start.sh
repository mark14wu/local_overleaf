#!/usr/bin/env bash
cd "$(dirname "$0")/app"
npm install --silent
node server.js
