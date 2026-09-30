#!/bin/bash
# Store your OpenRouter API key where monkey-see can find it.
#
#   bash setup-key.sh
#
# The key is written to ~/.config/monkeydo/key — OUTSIDE this project, so it
# can never be committed to git by accident — with permissions 600, meaning
# only you can read it.
#
# Note on `read`: in bash, `read -s -p "text" VAR` prints the text and reads
# silently. In zsh the same flags mean something else entirely, which is why
# this is a script you run with `bash` rather than a line to paste into your
# shell. Running it explicitly with bash makes it work the same way every time.

set -e

DIR="$HOME/.config/monkeydo"
FILE="$DIR/key"

echo "Monkey See — API key setup"
echo
echo "  1. Open   https://openrouter.ai/keys"
echo "  2. If you have already pasted a key into a chat, a screenshot, or"
echo "     anywhere public, DELETE it there and create a new one first."
echo "  3. Create a key, copy it, then come back here."
echo

read -r -p "  Paste your key here (nothing will be shown): " KEY
echo

# Some copy-and-paste methods append a carriage return. Strip it.
KEY=$(printf '%s' "$KEY" | tr -d '\r\n')

if [ -z "$KEY" ]; then
  echo "  No key entered, so nothing was saved. Run this again when ready."
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
printf '%s' "$KEY" > "$FILE"
chmod 600 "$FILE"

echo "  Saved. Now run the eval:"
echo
echo "    npm run see -- -m openrouter/dots-3-note-preview:free -r 3"
echo
echo "  To delete the key later:  rm $FILE"
