# Codex CLI'nin yerelde bıraktıkları — panel için notlar

> 2026-11-22 araştırması. Güncel sürüm rust-v0.171.0 (2026-11-20). Kaynak kod bulguları `main` dalından; 0.171.0
> etiketiyle birebir doğrulanmadı. "Doğrulanamadı" yazanlar kodlamadan önce ölçülecek (bu bilgisayarda Codex kurulu değil).

## Oturum dosyaları
- Kök: `CODEX_HOME`, varsayılan `~/.codex` [1]. Windows yolu belgede yok (`%USERPROFILE%\.codex` varsayımı, doğrulanamadı).
- `sessions/YYYY/MM/DD/rollout-<UTC YYYY-MM-DDThh-mm-ss>-<thread_id>.jsonl`; arşiv `archived_sessions/` [2]. Tarih UTC.
- 7 günden eski dosyalar `.jsonl.zst` olabilir [2]; panel atlar.
- Satır: `{"timestamp":"…Z","type":"…","payload":{…}}`. Türler: `session_meta` (İLK satır belirleyici; sonraki kopyalar yok sayılır),
  `response_item`, `turn_context`, `event_msg`, `compacted` [2][3].
- `session_meta`: `id` (yeni: `session_id`), `timestamp`, `cwd`, `originator`, `cli_version`, `source` (`cli`, `vscode`, `exec`,
  `mcp`, `subagent`…), `model_provider`, `git` [3]. Model adı `turn_context.model`'da.
- Mesajlar iki biçimde aranır: `event_msg` `user_message`/`agent_message` (`message`) ve `response_item` `message`
  (`role`, `content[].text`). Hangi kalıcılık modunun varsayılan olduğu doğrulanamadı [4].
- Tur: `event_msg` `task_started`/`turn_started`, `task_complete`/`turn_complete`, `turn_aborted` [3].
- Ad: `CODEX_HOME/session_index.jsonl` `{id, thread_name, updated_at}`, son satır geçerli [2].

## Çalışıyor mu
- `CODEX_HOME/thread-writer-locks/<thread_id>.lock`: boş dosya, canlılık işletim sistemi kilidiyle; dosya canlı olmadan da
  kalabilir [2]. Panel kilit ALMAYA çalışmaz (Codex'in yazmasını bozabilir); kilit dosyası + rollout mtime ile sezgi.
- Onay bekleme dosyaya YAZILMAZ (geçici olay) [4]; dolaylı iz: çıktısı gelmemiş `function_call`. Kesin yol Codex hook'u
  `PermissionRequest` [5] (kullanıcı ayarına yazmak gerekir → v1 dışı).
- Dosyayı `FileShare.ReadWrite | Delete` ile aç; yarım son satırı ve bilinmeyen türleri atla.

## Devam ettirme
- `codex resume <id>` / `--last` (geçerli klasör) / `--all`; `codex exec resume <id> [istem]`; `codex exec --json` [6].
- Kilit canlıyken devam ettirme önerilmez ("thread already has an active writer").

## Kota
- `event_msg` `token_count`: `info.total_token_usage`, `rate_limits.primary/secondary` (`used_percent`, `window_minutes`
  300/10080, `resets_at` Unix sn), `plan_type` [3].

## Risk
Biçim sık değişiyor (alan adları, takma adlar, sıkıştırma, kalıcılık modu). Savunmacı okuma + `cli_version` loglanır.

## Ölçüm — bu bilgisayar, codex-cli 0.171.0, 2026-11-22 (saha tespiti)
Tek `codex exec` oturumu (ChatGPT Go hesabı), 30 satır:
- Kök `C:\Users\<kullanıcı>\.codex` (Windows yolu doğrulandı). Dosya `sessions/2026/11/22/rollout-2026-11-22T02-23-32-<uuid>.jsonl`:
  klasör ve ad **yerel saat** (02:23 yerel = 23:23 UTC; zaman damgaları UTC). Belgedeki "UTC" ifadesi bu sürümde tutmadı.
- `session_meta`: `id` = `session_id`, `source: "exec"`, `originator: "codex_exec"`, `thread_source: "user"`, `history_mode: "paginated"`,
  `cwd`, `cli_version`, `git {commit_hash, branch, repository_url}`; ayrıca `base_instructions` (uzun), `creator_account_id` (kişisel — loga yazılmaz).
- Satır türleri: `session_meta`, `event_msg`, `response_item`, `turn_context`, `world_state` (yeni), `token_usage_record` (yeni).
- `event_msg` türleri: `task_started`, `thread_settings_applied`, `item_completed` (`item.type` `UserMessage` / `AgentMessage`, `content`),
  `token_count`, `task_complete` (`completed_at` Unix sn, `duration_ms`, `last_agent_message`). `user_message`/`agent_message` YOK (paginated mod).
- `response_item` `message`: rol `developer` (sistem), `user` (ilki `<environment_context>` enjekte metni — gösterilmez), `assistant`;
  `content[].text` (`input_text` / `output_text`). Ayrıca `custom_tool_call(_output)`, `reasoning`, `additional_tools`.
- Model `turn_context.model` (bu hesapta `gpt-6-luna`).
- `token_count.rate_limits`: `limit_id: "codex"`, `plan_type: "go"`, `primary.window_minutes: 43200` (30 gün; Go planında 5 sa/haftalık
  yerine aylık pencere), `secondary: null`, `resets_at` Unix sn, `credits`.
- `exec` bitince `thread-writer-locks/` BOŞ; `session_index.jsonl` oluşmadı (adsız oturum). Etkileşimli oturumda kilit henüz ölçülmedi.
- Windows'ta `--sandbox read-only` komut çalıştırmayı da engelledi ("blocked by policy").

## Kaynaklar (2026-11-22)
1. https://learn.chatgpt.com/docs/config-file/config-advanced
2. https://github.com/openai/codex/tree/main/codex-rs/rollout/src (recorder.rs, rollout_file_name.rs, compression.rs, list.rs, session_index.rs, writer_lock.rs)
3. https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
4. https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs
5. https://learn.chatgpt.com/docs/hooks
6. https://learn.chatgpt.com/docs/developer-commands?surface=cli
7. Üçüncü taraf (yalnız karşılaştırma): https://lin-guanguo.github.io/llm-memory-research/agent-cli/codex-session-file-schema/ , https://docs.rs/crate/abtop/0.4.6/source/src/collector/codex.rs
