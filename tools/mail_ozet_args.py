# tools/mail_ozet_test.sh yardımcısı: sahte claude.exe'nin kaydettiği ilk açılışın argümanlarını (satır başına bir argüman,
# açılışlar "---" ile ayrılır) denetler, dört satır yazar.
import json
import sys

a = open(sys.argv[1], encoding="utf-8").read().split("---\n")[1].splitlines()


def val(flag):
    return a[a.index(flag) + 1] if flag in a else ""


allowed, denied = val("--allowedTools").split(","), val("--disallowedTools").split(",")
env = (json.loads(val("--settings") or "{}").get("env") or {}).get("ENABLE_CLAUDEAI_MCP_SERVERS")
print("env" if env == "true" else f"envyok:{env}")
print(len(allowed), "mcp__claude_ai_Gmail__search_threads" in allowed, "mcp__claude_ai_Google_Calendar__list_events" in allowed)
print("mcp__claude_ai_Gmail__send_message" in denied, "mcp__claude_ai_Google_Calendar__create_event" in denied,
      len(set(allowed) & set(denied)))
print(any(w in t for t in allowed for w in ("send", "create", "delete", "update", "trash", "reply", "forward", "label_")))
