#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# TikTok Shop Content Pipeline — Claude Code Skill Installer
# ──────────────────────────────────────────────────────────────────────────────
# Installs the skill into your Claude Code setup so you can run:
#   "Build me a TikTok Shop content pipeline"
# and Claude walks you through the entire setup from scratch.
# ──────────────────────────────────────────────────────────────────────────────

set -e

SKILL_NAME="tiktok-shop-content-pipeline"
SKILL_SRC="$(cd "$(dirname "$0")" && pwd)/SKILL.md"

# Determine Claude Code skills directory
if [ -d "$HOME/.claude/skills" ]; then
  SKILLS_DIR="$HOME/.claude/skills"
elif [ -d "$HOME/Library/Application Support/Claude/skills" ]; then
  SKILLS_DIR="$HOME/Library/Application Support/Claude/skills"
else
  SKILLS_DIR="$HOME/.claude/skills"
  mkdir -p "$SKILLS_DIR"
fi

DEST_DIR="$SKILLS_DIR/$SKILL_NAME"

echo ""
echo "  ┌─────────────────────────────────────────────┐"
echo "  │  TikTok Shop Content Pipeline Installer      │"
echo "  └─────────────────────────────────────────────┘"
echo ""

# Copy skill
mkdir -p "$DEST_DIR"
cp "$SKILL_SRC" "$DEST_DIR/SKILL.md"

echo "  ✓ Skill installed to: $DEST_DIR"
echo ""
echo "  ─────────────────────────────────────────────"
echo "  How to use:"
echo ""
echo "  1. Open Claude Code in a new project folder"
echo "  2. Say: \"Build me a TikTok Shop content pipeline\""
echo "  3. Claude will guide you through the full setup"
echo "  ─────────────────────────────────────────────"
echo ""
echo "  The pipeline includes:"
echo "  • Brief → Trends → Ideas → Scripts → Upload"
echo "  • TikTok Shop publishing via Storista"
echo "  • Multi-platform scheduling via Buffer"
echo "  • AI video generation via Arcads"
echo "  • TikTok analytics via Apify"
echo "  • Deploys to Railway with team auth"
echo ""
