#!/usr/bin/env bash

pick() {
  local choice="$1" key rest
  while true; do
    key=""
    IFS= read -rsn1 key || true
    if [[ -z "$key" ]]; then
      printf '%s' "$choice"
      return
    fi
    if [[ "$key" == $'\e' ]]; then
      rest=""
      IFS= read -rsn2 rest || true
      case "$rest" in
        '[A') ((choice > 1)) && ((choice--)) ;;
        '[B') ((choice++)) ;;
      esac
    fi
  done
}

if [[ "${1:-}" == "approval" ]]; then
  printf 'Would you like to run the following command?\nEnvironment: local\nReason: Verify Ark before publishing it.\nCommand: npm run check; printf "32.26 17.10 13.06"; head -100\n› 1. Yes, proceed (y)\n2. Yes, and do not ask again for this prefix (p)\n3. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel\n'
  answer=$(pick 1)
  clear
  printf 'picked:%s\n' "$answer"
  exit
fi

if [[ "${1:-}" == "permissions" ]]; then
  printf 'Update Model Permissions\n› 1. Ask for approval (current)  Workspace access with approval outside it.\n2. Approve for me  Only ask for potentially unsafe actions.\n3. Full Access  Outside files and internet without asking.\nPress enter to confirm or esc to go back\n'
  answer=$(pick 1)
  clear
  printf 'permissions:%s\n' "$answer"
  exit
fi

if [[ "${1:-}" == "safety" ]]; then
  printf 'Additional safety checks\nThis request requires additional safety checks, which can take extra time.\n\n› 1. Keep waiting\n2. Learn more\n\nPress enter to confirm or esc to go back\n'
  answer=$(pick 1)
  clear
  printf 'safety:%s\n' "$answer"
  exit
fi

if [[ "${1:-}" == "goal" ]]; then
  printf 'Resume paused goal?\nGoal: Process the active work queue.\n\n› 1. Resume goal   Mark it active and continue when idle\n2. Leave paused  Keep it paused; use /goal resume later\n\nPress enter to confirm or esc to go back\n'
  answer=$(pick 1)
  clear
  printf 'goal:%s\n' "$answer"
  exit
fi

printf 'Select Model and Effort\n1. gpt-5.5 (default) Frontier model\n› 2. gpt-5.6-sol (current) Latest frontier agentic coding model.\n3. gpt-5.6-terraBalanced agentic coding model.\n4. gpt-5.6-lunaFast and affordable agentic coding model.\n5. gpt-5.4Strong model for everyday coding.\n6. gpt-5.4-miniSmall, fast model.\n7. gpt-5.3-codex-sparkUltra-fast coding model.\nPress enter to confirm or esc to go back\n'
model=$(pick 2)
clear
printf 'Select Reasoning Level for gpt-5.6-luna\n1.LowFast responses\n2.Medium (default)Balanced reasoning\n› 3.High (current)Greater reasoning\n4.Extra highExtra high reasoning\n5.MaxMaximum reasoning depth\n6.UltraMaximum reasoning with automatic task delegation\nPress enter to confirm or esc to go back\n'
effort=$(pick 3)
clear
printf 'selected:%s/%s\ngpt-5.6-luna ultra fast · /tmp\n' "$model" "$effort"
