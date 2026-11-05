-- Store only a fixed public-safe reason, never provider responses or document text.
ALTER TABLE ai_chat_requests ADD COLUMN IF NOT EXISTS failure_code text
  CHECK (failure_code IS NULL OR failure_code IN (
    'invalid_attachment', 'attachment_unreadable', 'provider_unavailable',
    'timeout', 'busy', 'unknown_failure', 'bridge_unavailable',
    'invalid_response', 'request_expired'
  ));
