#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# mex update — pull latest infrastructure files without touching populated content
# ─────────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      echo "Usage: .mex/update.sh"
      echo ""
      echo "Pull latest mex infrastructure files without touching your populated content."
      echo "Rebuilds CLI automatically if source files changed."
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="https://github.com/theDakshJaitly/mex.git"
TMP_DIR=""

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'
# Royal blue #1944F1
ROYAL='\033[38;2;25;68;241m'

info()  { printf "${BLUE}→${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}!${NC} %s\n" "$1"; }
header(){ printf "\n${BOLD}%s${NC}\n" "$1"; }

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

banner() {
  local GRN='\033[38;2;91;140;90m'
  local DGR='\033[38;2;74;122;73m'
  local ORN='\033[38;2;232;132;92m'
  local DRK='\033[38;2;61;61;61m'
  printf "\n"
  printf "${GRN}     ████      ${ROYAL}███╗   ███╗███████╗██╗  ██╗${NC}\n"
  printf "${GRN}    █${DGR}█${GRN}██${DGR}█${GRN}█     ${ROYAL}████╗ ████║██╔════╝╚██╗██╔╝${NC}\n"
  printf "${ORN}  ██████████   ${ROYAL}██╔████╔██║█████╗   ╚███╔╝${NC}\n"
  printf "${ORN}█ ██${DRK}██${ORN}██${DRK}██${ORN}██ █ ${ROYAL}██║╚██╔╝██║██╔══╝   ██╔██╗${NC}\n"
  printf "${ORN}█ ██████████ █ ${ROYAL}██║ ╚═╝ ██║███████╗██╔╝ ██╗${NC}\n"
  printf "${ORN}   █ █  █ █    ${ROYAL}╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝${NC}\n"
  printf "\n"
  printf "               ${BOLD}update${NC}\n"
}

# ─────────────────────────────────────────────────────────────
# Infrastructure files — safe to overwrite
# ─────────────────────────────────────────────────────────────

# These are owned by mex, not the user's populated content
INFRA_FILES=(
  "setup.sh"
  "setup.ps1"
  "update.sh"
  "sync.sh"
  "visualize.sh"
  "SETUP.md"
  "SYNC.md"
  "LICENSE"
  "patterns/README.md"
  "package.json"
  "tsconfig.json"
  "tsup.config.ts"
)

INFRA_DIRS=(
  ".tool-configs"
  "src"
  "test"
)

# Content files — NEVER overwrite
# AGENTS.md, ROUTER.md, context/*, patterns/INDEX.md, patterns/*.md (user-created)

# ─────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────

banner
echo ""

# Verify we're in a mex scaffold directory
if [ ! -f "$SCRIPT_DIR/ROUTER.md" ]; then
  echo "Error: cannot find ROUTER.md — are you sure this is a mex scaffold directory?"
  exit 1
fi

# Get current commit hash
CURRENT_HASH=""
if [ -d "$SCRIPT_DIR/.git" ]; then
  CURRENT_HASH=$(cd "$SCRIPT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
elif [ -f "$SCRIPT_DIR/.mex-version" ]; then
  CURRENT_HASH=$(cat "$SCRIPT_DIR/.mex-version" 2>/dev/null || echo "unknown")
fi

# Fetch latest
header "Fetching latest mex..."
TMP_DIR=$(mktemp -d)
git clone --quiet --depth 1 "$REPO_URL" "$TMP_DIR"
LATEST_HASH=$(cd "$TMP_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
ok "Fetched latest from GitHub"

if [ -n "$CURRENT_HASH" ] && [ "$CURRENT_HASH" != "unknown" ]; then
  if [ "$CURRENT_HASH" = "$LATEST_HASH" ]; then
    info "Current: ${CURRENT_HASH} — already on latest"
  else
    info "Current: ${CURRENT_HASH} → Latest: ${LATEST_HASH}"
  fi
fi
echo ""

# Track changes
UPDATED=()
ADDED=()
UNCHANGED=()

# Update infrastructure files
header "Updating infrastructure files..."

for file in "${INFRA_FILES[@]}"; do
  src="$TMP_DIR/$file"
  dest="$SCRIPT_DIR/$file"

  if [ ! -f "$src" ]; then
    continue
  fi

  if [ ! -f "$dest" ]; then
    # New file from upstream
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    ADDED+=("$file")
    ok "Added $file (new)"
  elif ! diff -q "$src" "$dest" &>/dev/null; then
    # File changed
    cp "$src" "$dest"
    UPDATED+=("$file")
    ok "Updated $file"
  else
    UNCHANGED+=("$file")
  fi
done

# Update infrastructure directories (recursive)
for dir in "${INFRA_DIRS[@]}"; do
  src_dir="$TMP_DIR/$dir"
  dest_dir="$SCRIPT_DIR/$dir"

  if [ ! -d "$src_dir" ]; then
    continue
  fi

  # Find all files recursively in the source directory
  while IFS= read -r src_file; do
    rel_path="${src_file#"$src_dir/"}"
    dest_file="$dest_dir/$rel_path"

    mkdir -p "$(dirname "$dest_file")"

    if [ ! -f "$dest_file" ]; then
      cp "$src_file" "$dest_file"
      ADDED+=("$dir/$rel_path")
      ok "Added $dir/$rel_path (new)"
    elif ! diff -q "$src_file" "$dest_file" &>/dev/null; then
      cp "$src_file" "$dest_file"
      UPDATED+=("$dir/$rel_path")
      ok "Updated $dir/$rel_path"
    else
      UNCHANGED+=("$dir/$rel_path")
    fi
  done < <(find "$src_dir" -type f)
done

# Preserve executable permissions on scripts
chmod +x "$SCRIPT_DIR/setup.sh" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/setup.ps1" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/update.sh" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/sync.sh" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/visualize.sh" 2>/dev/null || true

# Rebuild CLI if source files were updated
CLI_UPDATED=0
for f in "${UPDATED[@]}" "${ADDED[@]}"; do
  case "$f" in
    src/*|package.json|tsconfig.json|tsup.config.ts) CLI_UPDATED=1 ;;
  esac
done

if [ "$CLI_UPDATED" -eq 1 ] && command -v node &>/dev/null; then
  echo ""
  header "Rebuilding CLI engine..."
  if (cd "$SCRIPT_DIR" && npm install --silent 2>/dev/null && npm run build --silent 2>/dev/null); then
    ok "CLI engine rebuilt"
  else
    warn "CLI rebuild failed — run manually: cd .mex && npm install && npm run build"
  fi
fi

echo ""

# Check if upstream has new structural changes to content files
# (new sections in ROUTER.md, new context files, etc.)
header "Checking for structural changes..."

STRUCTURAL_NOTES=()

# Check if upstream added new context files
for src_file in "$TMP_DIR"/context/*.md; do
  [ -f "$src_file" ] || continue
  filename="$(basename "$src_file")"
  if [ ! -f "$SCRIPT_DIR/context/$filename" ]; then
    cp "$src_file" "$SCRIPT_DIR/context/$filename"
    ADDED+=("context/$filename")
    ok "Added context/$filename (new context file)"
  fi
done

# Check if ROUTER.md or AGENTS.md templates have new sections
for file in ROUTER.md AGENTS.md; do
  src="$TMP_DIR/$file"
  dest="$SCRIPT_DIR/$file"
  if [ -f "$src" ] && [ -f "$dest" ]; then
    # Count ## headings in upstream vs local
    src_sections=$(grep -c '^## ' "$src" 2>/dev/null || echo 0)
    dest_sections=$(grep -c '^## ' "$dest" 2>/dev/null || echo 0)
    if [ "$src_sections" -gt "$dest_sections" ]; then
      STRUCTURAL_NOTES+=("$file has new sections upstream — consider running SYNC.md to pick them up")
    fi
  fi
done

echo ""

# Summary
header "Summary"

if [ ${#UPDATED[@]} -eq 0 ] && [ ${#ADDED[@]} -eq 0 ]; then
  ok "Already up to date — no changes needed"
else
  if [ ${#UPDATED[@]} -gt 0 ]; then
    info "Updated: ${UPDATED[*]}"
  fi
  if [ ${#ADDED[@]} -gt 0 ]; then
    info "Added: ${ADDED[*]}"
  fi
fi

if [ ${#UNCHANGED[@]} -gt 0 ]; then
  info "Unchanged: ${#UNCHANGED[@]} files"
fi

# Print structural notes if any
if [ ${#STRUCTURAL_NOTES[@]} -gt 0 ]; then
  echo ""
  for note in "${STRUCTURAL_NOTES[@]}"; do
    warn "$note"
  done
fi

# Save version hash for future reference
echo "$LATEST_HASH" > "$SCRIPT_DIR/.mex-version"

echo ""
ok "Done. Your populated content files were not touched."
