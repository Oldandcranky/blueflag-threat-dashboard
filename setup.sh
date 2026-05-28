#!/usr/bin/env bash
# BlueFlag Security — Threat Dashboard
# First-time setup script  ·  macOS only

# ── Colors ─────────────────────────────────────────────────────────────────────
R=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[38;5;46m'
BLUE=$'\033[38;5;33m'
CYAN=$'\033[38;5;51m'
YELLOW=$'\033[38;5;220m'
RED=$'\033[38;5;196m'
WHITE=$'\033[97m'
GRAY=$'\033[38;5;244m'
SEP="${GRAY}  ──────────────────────────────────────────────────────${R}"

# ── Helpers ────────────────────────────────────────────────────────────────────
ok()    { echo -e "  ${GREEN}✓${R}  $1"; }
skip()  { echo -e "  ${CYAN}↷${R}  ${DIM}$1${R}"; }
step()  { echo -e "  ${BLUE}→${R}  $1"; }
warn()  { echo -e "  ${YELLOW}⚠${R}  $1"; }
info()  { echo -e "  ${GRAY}${DIM}$1${R}"; }
blank() { echo ""; }

section() {
  blank
  echo -e "${BOLD}${WHITE}  $1${R}"
  echo -e "$SEP"
}

die() {
  echo -e "\n  ${RED}✗${R}  $1"
  blank
  echo -e "  ${RED}${BOLD}Setup failed.${R}  Fix the issue above and run ${BOLD}./setup.sh${R} again."
  blank
  tput cnorm 2>/dev/null
  exit 1
}

# ── Spinner ────────────────────────────────────────────────────────────────────
spin() {
  local msg="$1" pid="$2"
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local i=0
  tput civis 2>/dev/null
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${CYAN}${frames[$i]}${R}  %s" "$msg"
    i=$(( (i + 1) % 10 ))
    sleep 0.08
  done
  tput cnorm 2>/dev/null
  printf "\r\033[K"
}

# Runs a command silently in the background with a spinner.
# On failure, dumps captured output and dies.
run_bg() {
  local label="$1"; shift
  local tmplog
  tmplog=$(mktemp)
  "$@" >"$tmplog" 2>&1 &
  local pid=$!
  spin "$label" "$pid"
  wait "$pid"
  local code=$?
  if [ "$code" -ne 0 ]; then
    blank
    while IFS= read -r line; do info "$line"; done < "$tmplog"
    rm -f "$tmplog"
    die "$label failed (exit $code)"
  fi
  rm -f "$tmplog"
}

# ── Banner ─────────────────────────────────────────────────────────────────────
clear
blank
echo -e "${BOLD}${BLUE}  ┌──────────────────────────────────────────────────────┐${R}"
echo -e "${BOLD}${BLUE}  │${R}                                                        ${BOLD}${BLUE}│${R}"
echo -e "${BOLD}${BLUE}  │${R}    ${BOLD}${WHITE}BlueFlag Security${R}  ${GRAY}·${R}  ${DIM}Threat Dashboard${R}             ${BOLD}${BLUE}│${R}"
echo -e "${BOLD}${BLUE}  │${R}    ${DIM}${GRAY}First-time setup  ·  macOS${R}                          ${BOLD}${BLUE}│${R}"
echo -e "${BOLD}${BLUE}  │${R}                                                        ${BOLD}${BLUE}│${R}"
echo -e "${BOLD}${BLUE}  └──────────────────────────────────────────────────────┘${R}"
blank

# Confirm we're in the right folder
if [ ! -f "package.json" ] || [ ! -f "server.js" ]; then
  die "Run this from the blueflag-monitor project folder:\n       cd blueflag-monitor && ./setup.sh"
fi

if [[ "$(uname)" != "Darwin" ]]; then
  die "This script is for macOS only."
fi

# ── Step 1: Homebrew ───────────────────────────────────────────────────────────
section "1 / 5  —  Homebrew"

if command -v brew &>/dev/null; then
  BREW_VER=$(brew --version 2>/dev/null | head -1 | sed 's/Homebrew //')
  ok "Homebrew $BREW_VER already installed"
else
  step "Homebrew not found — installing now"
  blank
  warn "The installer may ask for your Mac password — this is normal."
  warn "Press ENTER when prompted to continue."
  blank
  echo -e "$SEP"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  echo -e "$SEP"
  blank

  # Add brew to PATH for this session (Apple Silicon: /opt/homebrew, Intel: /usr/local)
  if [ -x "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x "/usr/local/bin/brew" ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  command -v brew &>/dev/null || die "Homebrew install failed. Visit https://brew.sh for help."
  ok "Homebrew installed"
fi

# ── Step 2: Node.js ────────────────────────────────────────────────────────────
section "2 / 5  —  Node.js"

if ! command -v node &>/dev/null; then
  step "Node.js not found — installing via Homebrew..."
  run_bg "Installing Node.js" brew install node
  ok "Node.js installed"
fi

NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)

if (( NODE_MAJOR < 18 )); then
  step "Node.js v$NODE_VER is too old (need v18+) — upgrading..."
  if brew list --formula node &>/dev/null 2>&1; then
    run_bg "Upgrading Node.js via Homebrew" brew upgrade node
  else
    run_bg "Installing Node.js v18+ via Homebrew" brew install node
  fi
  NODE_VER=$(node -e "process.stdout.write(process.versions.node)")
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  (( NODE_MAJOR >= 18 )) || die "Node.js upgrade failed. Try manually: brew upgrade node"
  ok "Node.js upgraded to v$NODE_VER"
else
  ok "Node.js v$NODE_VER"
fi

ok "npm v$(npm -v)"

# ── Step 3: npm packages ───────────────────────────────────────────────────────
section "3 / 5  —  npm packages"

if [ -f "node_modules/.package-lock.json" ]; then
  skip "node_modules already present — skipping install"
  info "Run 'npm install' manually if you've added packages"
else
  step "Installing project dependencies..."
  run_bg "npm install" npm install --silent
  ok "All packages installed"
fi

# ── Step 4: Playwright / Chromium ─────────────────────────────────────────────
section "4 / 5  —  Playwright (headless browser)"

PW_CACHE="${HOME}/Library/Caches/ms-playwright"
if [ -d "$PW_CACHE" ] && ls "$PW_CACHE"/chromium-* 2>/dev/null | grep -q .; then
  skip "Chromium already installed"
  info "Location: $PW_CACHE"
else
  step "Downloading Chromium (~130 MB, one-time only)..."
  info "This takes 1–2 minutes on a decent connection — grab a coffee."
  run_bg "Downloading Chromium" npx playwright install chromium
  ok "Chromium ready"
fi

step "Verifying Playwright can find the browser..."
if node -e "const{chromium}=require('playwright');chromium.executablePath()" &>/dev/null; then
  ok "Playwright verified"
else
  die "Playwright setup looks broken.\n       Try manually: npx playwright install chromium"
fi

# ── Step 5: Config ─────────────────────────────────────────────────────────────
section "5 / 5  —  Configuration"

if [ -f "config.json" ]; then
  skip "config.json already exists — your settings are untouched"
else
  [ -f "config.example.json" ] || die "config.example.json is missing from the project folder."
  cp config.example.json config.json
  ok "Created config.json from template"
  warn "Open Settings in the app to add credentials and your Claude API key"
fi

# ── Port check ─────────────────────────────────────────────────────────────────
if lsof -Pi :3737 -sTCP:LISTEN -t &>/dev/null; then
  blank
  warn "Port 3737 is already in use — a server may already be running."
  step "Opening http://localhost:3737 ..."
  open "http://localhost:3737"
  blank
  exit 0
fi

# ── Launch ─────────────────────────────────────────────────────────────────────
blank
echo -e "$SEP"
blank
echo -e "  ${GREEN}${BOLD}Everything is ready. Launching the Threat Dashboard...${R}"
blank
echo -e "  ${GRAY}URL   ${R}  ${BOLD}http://localhost:3737${R}"
echo -e "  ${GRAY}Stop  ${R}  ${BOLD}Ctrl+C${R}"
echo -e "  ${GRAY}Later ${R}  ${BOLD}node server.js${R} to start without running setup again"
blank
echo -e "$SEP"
blank

node server.js
