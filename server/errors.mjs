const ERROR_TYPE_BASE = 'https://api.deckbridge.app/errors';

const CODE_TO_TITLE = {
  internal_error: 'Internal Server Error',
  request_error: 'Bad Request',
  missing_upload: 'Missing Upload',
  invalid_upload_type: 'Invalid Upload Type',
  missing_credentials: 'Missing Credentials',
  invalid_credentials: 'Invalid Credentials',
  unauthorized: 'Unauthorized',
  forbidden: 'Forbidden',
  not_found: 'Not Found',
  deck_not_found: 'Deck Not Found',
  card_not_found: 'Card Not Found',
  suggestion_not_found: 'Suggestion Not Found',
  conflict_not_found: 'Conflict Not Found',
  invite_not_found: 'Invite Not Found',
  template_not_found: 'Template Not Found',
  profile_not_found: 'Profile Not Found',
  media_not_found: 'Media Not Found',
  addon_not_built: 'Add-on Not Built',
  conflict: 'Conflict',
  gone: 'Gone',
  invite_used: 'Invite Already Used',
  invite_expired: 'Invite Expired',
  rate_limited: 'Rate Limit Exceeded',
  invalid_deck_id: 'Invalid Deck ID',
  invalid_decision: 'Invalid Decision',
  invalid_cursor: 'Invalid Cursor',
  invalid_since: 'Invalid Since Parameter',
  invalid_email: 'Invalid Email',
  invalid_role: 'Invalid Role',
  invalid_visibility: 'Invalid Visibility',
  invalid_emoji: 'Invalid Emoji',
  invalid_sync_payload: 'Invalid Sync Payload',
  invalid_setup_error_payload: 'Invalid Setup Error Payload',
  invalid_media_filename: 'Invalid Media Filename',
  invalid_media_upload: 'Invalid Media Upload',
  invalid_card_id_column: 'Missing Card ID Column',
  missing_import_content: 'Missing Import Content',
  missing_import_header: 'Missing Import Header',
  missing_card_ids: 'Missing Card IDs',
  missing_suggestion_ids: 'Missing Suggestion IDs',
  invalid_suggestion_id: 'Invalid Suggestion ID',
  duplicate_suggestion_ids: 'Duplicate Suggestion IDs',
  too_many_suggestion_ids: 'Too Many Suggestion IDs',
  import_too_large: 'Import Too Large',
  missing_upload: 'Missing Upload',
  empty_comment: 'Empty Comment',
  password_hash_not_allowed: 'Password Hash Not Allowed',
  invalid_model_name: 'Invalid Model Name',
  comment_not_found: 'Comment Not Found',
  sync_conflicts: 'Sync Conflicts',
  local_bridge_required: 'Local Bridge Required',
  invalid_ai_subject_type: 'Invalid AI Subject Type',
  invalid_ai_artifact_kind: 'Invalid AI Artifact Kind',
  invalid_ai_artifact_severity: 'Invalid AI Artifact Severity',
  invalid_ai_artifact_status: 'Invalid AI Artifact Status',
  invalid_ai_model: 'Invalid AI Model',
  invalid_ai_prompt_version: 'Invalid AI Prompt Version',
  invalid_ai_input_hash: 'Invalid AI Input Hash',
  missing_ai_subject_id: 'Missing AI Subject ID',
  invalid_relationship: 'Invalid Relationship',
  invite_email_mismatch: 'Invite Email Mismatch',
};

function titleForCode(code) {
  return CODE_TO_TITLE[code] || 'Request Error';
}

export class AppError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  }
}

export function fail(status, code, message, details = {}) {
  throw new AppError(status, code, message, details);
}

function boundedDetails(details = {}) {
  const bounded = {};
  for (const [key, value] of Object.entries(details || {}).slice(0, 12)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      bounded[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
  }
  return bounded;
}

export function errorPayload(error, production = false) {
  const status = error.status || 500;
  const code = error.code || (status === 500 ? 'internal_error' : 'request_error');
  const detail = status === 500 && production ? 'Unexpected server error' : error.message || 'Unexpected server error';
  const title = titleForCode(code);
  return {
    status,
    body: {
      type: `${ERROR_TYPE_BASE}/${code}`,
      title,
      status,
      detail,
      code,
      details: boundedDetails(error.details),
      message: detail,
      error: { code, message: detail }
    }
  };
}
