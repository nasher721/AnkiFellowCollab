import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

aqt_mock = MagicMock()
aqt_mock.gui_hooks = MagicMock()
aqt_mock.mw = MagicMock()
sys.modules['aqt'] = aqt_mock
sys.modules['aqt.qt'] = MagicMock()
sys.modules['aqt.utils'] = MagicMock()
sys.modules['anki'] = MagicMock()
sys.modules['anki.collection'] = MagicMock()

from deckbridge_sync import (
    ADDON_VERSION,
    apply_autoconfig,
    addon_manifest,
    config,
    create_platform_deck_from_anki,
    DEFAULT_CONFIG,
    CONFIG_KEY,
    last_autoconfig_error,
    login_to_account,
    local_deck_names,
    normalize_platform_url,
    open_settings,
    platform_url,
    pull_to_anki,
    save_config,
    safe_tag,
    tracking_tag,
    note_query,
    validate_token,
    TRACKING_TAG_PREFIX,
    _flat_from_stored,
    _handle_url_scheme,
)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode('utf-8')


def http_error(status, payload):
    return urllib.error.HTTPError(
        url='https://deckbridge.example/api/me',
        code=status,
        msg='Forbidden' if status == 403 else 'Unauthorized',
        hdrs={},
        fp=BytesIO(json.dumps(payload).encode('utf-8')),
    )


class TestApplyAutoconfig(unittest.TestCase):
    @patch('deckbridge_sync.validate_token')
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_parses_valid_url_returns_true(self, mock_config, mock_save, mock_validate):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        mock_validate.return_value = {'user': {'email': 'user@example.com'}, 'decks': []}
        url = (
            'anki://deckbridge?url=https%3A%2F%2Fdeckbridge.com&token=db_abc123'
            '&deckId=deck-1&localDeck=Boards%3A%3ANeuro&conflictPolicy=overwrite-platform'
        )
        result = apply_autoconfig(url)
        self.assertTrue(result)
        saved = mock_save.call_args[0][0]
        self.assertEqual(saved['platform_url'], 'https://deckbridge.com')
        self.assertEqual(saved['api_token'], 'db_abc123')
        self.assertEqual(saved['deck_id'], 'deck-1')
        self.assertEqual(saved['local_deck'], 'Boards::Neuro')
        self.assertEqual(saved['conflict_policy'], 'overwrite-platform')
        mock_validate.assert_called_once()

    @patch('deckbridge_sync.validate_token')
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_omitted_local_deck_clears_prior_mapping(self, mock_config, mock_save, mock_validate):
        mock_config.return_value = {**DEFAULT_CONFIG, 'local_deck': 'Old::Deck'}
        mock_validate.return_value = {'user': {'email': 'user@example.com'}, 'decks': []}
        url = (
            'anki://deckbridge?url=https%3A%2F%2Fdeckbridge.com&token=db_abc123'
            '&deckId=deck-1'
        )
        result = apply_autoconfig(url)
        self.assertTrue(result)
        saved = mock_save.call_args[0][0]
        self.assertEqual(saved['local_deck'], '')

    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_missing_token_returns_false(self, mock_config, mock_save):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = 'anki://deckbridge?url=https%3A%2F%2Fdeckbridge.com'
        result = apply_autoconfig(url)
        self.assertFalse(result)
        mock_save.assert_not_called()

    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_missing_url_returns_false(self, mock_config, mock_save):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = 'anki://deckbridge?token=db_abc123'
        result = apply_autoconfig(url)
        self.assertFalse(result)
        mock_save.assert_not_called()

    def test_wrong_scheme_returns_false(self):
        url = 'https://deckbridge?url=https%3A%2F%2Fdeckbridge.com&token=db_abc123'
        result = apply_autoconfig(url)
        self.assertFalse(result)

    def test_wrong_netloc_returns_false(self):
        url = 'anki://other?url=https%3A%2F%2Fdeckbridge.com&token=db_abc123'
        result = apply_autoconfig(url)
        self.assertFalse(result)

    def test_malformed_url_returns_false(self):
        result = apply_autoconfig('not a url at all')
        self.assertFalse(result)

    @patch('deckbridge_sync.urllib.request.urlopen')
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_non_db_token_returns_false_without_network(self, mock_config, mock_save, mock_urlopen):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = 'anki://deckbridge?url=https%3A%2F%2Fexample.com&token=not-db-token&deckId=deck-1'
        result = apply_autoconfig(url)
        self.assertFalse(result)
        mock_save.assert_not_called()
        mock_urlopen.assert_not_called()

    @patch('deckbridge_sync.validate_token')
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_missing_deck_id_returns_false_without_save(self, mock_config, mock_save, mock_validate):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        mock_validate.return_value = {'user': {'email': 'user@example.com'}, 'decks': []}
        url = 'anki://deckbridge?url=https%3A%2F%2Fexample.com%2F&token=db_tok'
        result = apply_autoconfig(url)
        self.assertFalse(result)
        mock_save.assert_not_called()
        mock_validate.assert_not_called()
        self.assertIn('deckId', last_autoconfig_error())

    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_blank_params_treated_as_missing(self, mock_config, mock_save):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = 'anki://deckbridge?url=&token=   &deckId=deck-1'
        result = apply_autoconfig(url)
        self.assertFalse(result)
        mock_save.assert_not_called()

    @patch('deckbridge_sync.validate_token', side_effect=RuntimeError('DeckBridge API 401: invalid token'))
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_invalid_autoconfig_token_is_not_saved(self, mock_config, mock_save, _mock_validate):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = 'anki://deckbridge?url=https%3A%2F%2Fexample.com&token=db_bad&deckId=deck-1'
        self.assertFalse(apply_autoconfig(url))
        mock_save.assert_not_called()

    @patch('deckbridge_sync.validate_token')
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_invalid_conflict_policy_is_not_saved(self, mock_config, mock_save, mock_validate):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = (
            'anki://deckbridge?url=https%3A%2F%2Fexample.com&token=db_good'
            '&deckId=deck-1&conflictPolicy=delete-local'
        )
        self.assertFalse(apply_autoconfig(url))
        mock_save.assert_not_called()
        mock_validate.assert_not_called()
        self.assertIn('conflictPolicy', last_autoconfig_error())

    @patch('deckbridge_sync.validate_token', return_value={'user': {'email': 'user@example.com'}, 'decks': []})
    @patch('deckbridge_sync.configure_timer')
    def test_autoconfig_persists_local_deck_and_conflict_policy_mapping(self, _mock_timer, _mock_validate):
        aqt_mock.mw.col.conf = {}
        aqt_mock.mw.addonManager.getConfig.return_value = None
        url = (
            'anki://deckbridge?url=https%3A%2F%2Fdeckbridge.example%2F'
            '&token=db_good&deckId=deck-neuro'
            '&localDeck=Boards%3A%3ANeuro%20ICU'
            '&conflictPolicy=overwrite-platform'
        )

        self.assertTrue(apply_autoconfig(url))

        stored = aqt_mock.mw.col.conf[CONFIG_KEY]
        self.assertEqual(stored['url'], 'https://deckbridge.example')
        self.assertEqual(stored['token'], 'db_good')
        self.assertEqual(stored['deckMappings'], [{
            'localDeck': 'Boards::Neuro ICU',
            'deckId': 'deck-neuro',
            'conflictPolicy': 'overwrite-platform',
        }])

    @patch('deckbridge_sync.validate_token', return_value={'user': {'email': 'user@example.com'}, 'decks': []})
    @patch('deckbridge_sync.configure_timer')
    def test_autoconfig_without_local_deck_persists_blank_mapping(self, _mock_timer, _mock_validate):
        aqt_mock.mw.col.conf = {
            CONFIG_KEY: {
                'url': 'https://old.example',
                'token': 'db_old',
                'deckMappings': [{
                    'localDeck': 'Old::Deck',
                    'deckId': 'deck-old',
                    'conflictPolicy': 'detect',
                }],
            }
        }
        aqt_mock.mw.addonManager.getConfig.return_value = None
        url = (
            'anki://deckbridge?url=https%3A%2F%2Fdeckbridge.example%2F'
            '&token=db_good&deckId=deck-neuro'
        )

        self.assertTrue(apply_autoconfig(url))

        stored = aqt_mock.mw.col.conf[CONFIG_KEY]
        self.assertEqual(stored['deckMappings'], [{
            'localDeck': '',
            'deckId': 'deck-neuro',
            'conflictPolicy': 'detect',
        }])


class TestVersion(unittest.TestCase):
    def test_manifest_is_version_source(self):
        self.assertEqual(addon_manifest()['version'], '0.2.0')
        self.assertEqual(ADDON_VERSION, addon_manifest()['version'])


class TestDefaultConfig(unittest.TestCase):
    def test_has_required_fields(self):
        required = [
            'platform_url', 'api_token', 'deck_id', 'email', 'local_deck',
            'conflict_policy', 'auto_sync_minutes', 'timeout_seconds',
            'batch_size', 'tag_filter', 'include_suspended',
            'create_missing_notes', 'pull_overwrites_local',
            'sync_on_profile_open', 'sync_on_close',
        ]
        for field in required:
            self.assertIn(field, DEFAULT_CONFIG, f"Missing field: {field}")

    def test_defaults(self):
        self.assertEqual(DEFAULT_CONFIG['platform_url'], 'https://anki-collab.vercel.app')
        self.assertEqual(DEFAULT_CONFIG['api_token'], '')
        self.assertEqual(DEFAULT_CONFIG['deck_id'], '')
        self.assertEqual(DEFAULT_CONFIG['local_deck'], '')
        self.assertEqual(DEFAULT_CONFIG['conflict_policy'], 'detect')
        self.assertEqual(DEFAULT_CONFIG['auto_sync_minutes'], 0)
        self.assertEqual(DEFAULT_CONFIG['sync_on_profile_open'], False)
        self.assertEqual(DEFAULT_CONFIG['sync_on_close'], False)

    def test_legacy_local_default_is_migrated_to_hosted_url(self):
        flat = _flat_from_stored({'url': 'http://localhost:4175', 'deckMappings': []})
        self.assertEqual(flat['platform_url'], 'https://anki-collab.vercel.app')


class TestPlatformUrl(unittest.TestCase):
    def test_joins_path(self):
        cfg = {'platform_url': 'http://localhost:4175'}
        self.assertEqual(platform_url(cfg, '/api/me'), 'http://localhost:4175/api/me')

    def test_strips_trailing_slash(self):
        cfg = {'platform_url': 'http://localhost:4175/'}
        self.assertEqual(platform_url(cfg, '/api/me'), 'http://localhost:4175/api/me')

    def test_normalizes_scheme_host_path_and_trailing_slash(self):
        self.assertEqual(
            normalize_platform_url(' HTTPS://DeckBridge.EXAMPLE/app/// '),
            'https://deckbridge.example/app',
        )

    def test_requires_http_url(self):
        with self.assertRaisesRegex(RuntimeError, 'http\\(s\\) URL'):
            normalize_platform_url('ftp://deckbridge.example')

    def test_rejects_query_and_fragment(self):
        with self.assertRaisesRegex(RuntimeError, 'query parameters'):
            normalize_platform_url('https://deckbridge.example?token=db_bad')


class TestSafeTag(unittest.TestCase):
    def test_replaces_special_chars(self):
        self.assertEqual(safe_tag('deck-1_ABC'), 'deck_1_ABC')

    def test_truncates_long_value(self):
        long_val = 'a' * 300
        self.assertEqual(len(safe_tag(long_val)), 180)

    def test_empty_string(self):
        self.assertEqual(safe_tag(''), '')


class TestTrackingTag(unittest.TestCase):
    def test_format(self):
        self.assertEqual(tracking_tag('card-123'), f'{TRACKING_TAG_PREFIX}card_123')

    def test_uses_safe_tag(self):
        self.assertEqual(tracking_tag('abc/def'), f'{TRACKING_TAG_PREFIX}abc_def')


class TestConfig(unittest.TestCase):
    def setUp(self):
        aqt_mock.mw.col.conf = {}
        aqt_mock.mw.col.set_config.reset_mock()
        aqt_mock.mw.addonManager.reset_mock()

    def test_merges_stored_over_defaults(self):
        aqt_mock.mw.addonManager.getConfig.return_value = {'api_token': 'stored_tok'}
        result = config()
        self.assertEqual(result['api_token'], 'stored_tok')
        self.assertEqual(result['platform_url'], DEFAULT_CONFIG['platform_url'])

    def test_returns_defaults_when_no_stored(self):
        aqt_mock.mw.addonManager.getConfig.return_value = None
        result = config()
        self.assertEqual(result, DEFAULT_CONFIG)

    def test_reads_collection_deckbridge_config(self):
        aqt_mock.mw.addonManager.getConfig.return_value = None
        aqt_mock.mw.col.conf = {
            CONFIG_KEY: {
                'url': 'https://deckbridge.example',
                'token': 'db_local',
                'deckMappings': [{
                    'localDeck': 'Boards::Neuro',
                    'deckId': 'deck-neuro',
                    'conflictPolicy': 'overwrite-platform',
                }],
                'autoSync': True,
                'auto_sync_minutes': 15,
            }
        }
        result = config()
        self.assertEqual(result['platform_url'], 'https://deckbridge.example')
        self.assertEqual(result['api_token'], 'db_local')
        self.assertEqual(result['local_deck'], 'Boards::Neuro')
        self.assertEqual(result['deck_id'], 'deck-neuro')
        self.assertEqual(result['conflict_policy'], 'overwrite-platform')
        self.assertEqual(result['auto_sync_minutes'], 15)

    @patch('deckbridge_sync.configure_timer')
    def test_save_config_persists_wizard_contract_under_collection_conf(self, _mock_timer):
        aqt_mock.mw.col.conf = {}
        aqt_mock.mw.addonManager.getConfig.return_value = None
        save_config({
            'platform_url': 'https://deckbridge.example',
            'api_token': 'db_saved',
            'deck_id': 'deck-abc',
            'local_deck': 'Boards::Neuro',
            'conflict_policy': 'detect',
            'auto_sync_minutes': 10,
        })
        stored = aqt_mock.mw.col.conf[CONFIG_KEY]
        self.assertEqual(stored['url'], 'https://deckbridge.example')
        self.assertEqual(stored['token'], 'db_saved')
        self.assertEqual(stored['deckMappings'], [{
            'localDeck': 'Boards::Neuro',
            'deckId': 'deck-abc',
            'conflictPolicy': 'detect',
        }])
        self.assertEqual(stored['auto_sync_minutes'], 10)
        aqt_mock.mw.addonManager.writeConfig.assert_not_called()

    @patch('deckbridge_sync.configure_timer')
    def test_save_config_rejects_invalid_url_and_preserves_prior_config(self, mock_timer):
        prior = {
            'url': 'https://deckbridge.example',
            'token': 'db_saved',
            'deckMappings': [{
                'localDeck': 'Boards::Neuro',
                'deckId': 'deck-abc',
                'conflictPolicy': 'detect',
            }],
        }
        aqt_mock.mw.col.conf = {CONFIG_KEY: prior.copy()}
        aqt_mock.mw.addonManager.getConfig.return_value = None

        with self.assertRaisesRegex(RuntimeError, 'http\\(s\\) URL'):
            save_config({
                'platform_url': 'ftp://deckbridge.example',
                'api_token': 'db_next',
            })

        self.assertEqual(aqt_mock.mw.col.conf[CONFIG_KEY], prior)
        aqt_mock.mw.col.set_config.assert_not_called()
        mock_timer.assert_not_called()

    @patch('deckbridge_sync.configure_timer')
    def test_save_config_rejects_invalid_token_and_preserves_prior_config(self, mock_timer):
        prior = {
            'url': 'https://deckbridge.example',
            'token': 'db_saved',
            'deckMappings': [{
                'localDeck': 'Boards::Neuro',
                'deckId': 'deck-abc',
                'conflictPolicy': 'detect',
            }],
        }
        aqt_mock.mw.col.conf = {CONFIG_KEY: prior.copy()}
        aqt_mock.mw.addonManager.getConfig.return_value = None

        with self.assertRaisesRegex(RuntimeError, 'must start with db_'):
            save_config({
                'platform_url': 'https://deckbridge.example',
                'api_token': 'legacy-token',
            })

        self.assertEqual(aqt_mock.mw.col.conf[CONFIG_KEY], prior)
        aqt_mock.mw.col.set_config.assert_not_called()
        mock_timer.assert_not_called()

    @patch('deckbridge_sync.configure_timer')
    def test_save_config_allows_blank_token_for_default_setup(self, _mock_timer):
        aqt_mock.mw.col.conf = {}
        aqt_mock.mw.addonManager.getConfig.return_value = None
        save_config({
            'platform_url': 'https://deckbridge.example',
            'api_token': '',
        })

        stored = aqt_mock.mw.col.conf[CONFIG_KEY]
        self.assertEqual(stored['url'], 'https://deckbridge.example')
        self.assertEqual(stored['token'], '')


class TestTokenValidation(unittest.TestCase):
    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_validate_token_returns_user_and_decks(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse({
            'user': {'email': 'user@example.com', 'name': 'User'},
            'decks': [{'id': 'deck-1', 'name': 'Deck 1'}],
        })
        result = validate_token({
            **DEFAULT_CONFIG,
            'platform_url': 'https://deckbridge.example',
            'api_token': 'db_token',
        })
        self.assertEqual(result['user']['email'], 'user@example.com')
        self.assertEqual(result['decks'][0]['id'], 'deck-1')
        request = mock_urlopen.call_args[0][0]
        self.assertEqual(request.full_url, 'https://deckbridge.example/api/me')
        self.assertEqual(request.headers['Authorization'], 'Bearer db_token')

    def test_validate_token_requires_token(self):
        with self.assertRaisesRegex(RuntimeError, 'token is required'):
            validate_token({**DEFAULT_CONFIG, 'api_token': ''})

    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_login_to_account_returns_addon_token(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse({
            'user': {'email': 'user@example.com', 'name': 'User'},
            'token': {'token': 'db_login_token'},
            'decks': [],
        })
        result = login_to_account('https://deckbridge.example', 'user@example.com', 'secret')
        self.assertEqual(result['api_token'], 'db_login_token')
        request = mock_urlopen.call_args[0][0]
        self.assertEqual(request.full_url, 'https://deckbridge.example/api/anki/login')
        self.assertNotIn('Authorization', request.headers)

    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.sync_payload', return_value={'cards': [{'id': 'anki-1', 'fields': {'Front': 'A'}}]})
    @patch('deckbridge_sync.request_json')
    def test_create_platform_deck_from_anki_saves_returned_deck_id(self, mock_request, _mock_payload, mock_save):
        mock_request.return_value = {
            'deck': {'id': 'deck-created', 'name': 'Created'},
            'result': {'stats': {'created': 1}},
        }
        result = create_platform_deck_from_anki({
            **DEFAULT_CONFIG,
            'platform_url': 'https://deckbridge.example',
            'api_token': 'db_token',
            'local_deck': 'Local Deck',
        })
        self.assertEqual(result['deck']['id'], 'deck-created')
        saved = mock_save.call_args[0][0]
        self.assertEqual(saved['deck_id'], 'deck-created')

    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_validate_token_rejects_non_db_without_network_call(self, mock_urlopen):
        with self.assertRaisesRegex(RuntimeError, 'must start with db_'):
            validate_token({
                **DEFAULT_CONFIG,
                'platform_url': 'https://deckbridge.example',
                'api_token': 'legacy-token',
            })
        mock_urlopen.assert_not_called()

    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_validate_token_reports_401(self, mock_urlopen):
        mock_urlopen.side_effect = http_error(401, {'error': {'message': 'invalid token'}})
        with self.assertRaisesRegex(RuntimeError, 'DeckBridge API 401: invalid token'):
            validate_token({
                **DEFAULT_CONFIG,
                'platform_url': 'https://deckbridge.example',
                'api_token': 'db_bad',
            })

    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_validate_token_reports_403(self, mock_urlopen):
        mock_urlopen.side_effect = http_error(403, {'error': {'message': 'forbidden'}})
        with self.assertRaisesRegex(RuntimeError, 'DeckBridge API 403: forbidden'):
            validate_token({
                **DEFAULT_CONFIG,
                'platform_url': 'https://deckbridge.example',
                'api_token': 'db_forbidden',
            })

    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_validate_token_reports_unreachable_api(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.URLError('connection refused')
        with self.assertRaisesRegex(RuntimeError, 'DeckBridge is unreachable'):
            validate_token({
                **DEFAULT_CONFIG,
                'platform_url': 'https://deckbridge.example',
                'api_token': 'db_unreachable',
            })


class TestOpenSettings(unittest.TestCase):
    def setUp(self):
        aqt_mock.mw.col.conf = {}
        aqt_mock.mw.addonManager.getConfig.return_value = None

    @patch('deckbridge_sync.showInfo')
    @patch('deckbridge_sync.tooltip')
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.validate_token', side_effect=RuntimeError('DeckBridge API 401: invalid token'))
    @patch('deckbridge_sync.SettingsDialog')
    def test_settings_save_requires_successful_validation(self, mock_dialog_class, _mock_validate, mock_save, mock_tooltip, mock_show):
        dialog = MagicMock()
        dialog.exec.return_value = True
        dialog.values.return_value = {
            **DEFAULT_CONFIG,
            'platform_url': 'https://deckbridge.example',
            'api_token': 'db_bad',
        }
        mock_dialog_class.return_value = dialog

        open_settings()

        mock_save.assert_not_called()
        mock_tooltip.assert_not_called()
        mock_show.assert_called_once()

    @patch('deckbridge_sync.post_cards')
    @patch('deckbridge_sync.QTimer.singleShot')
    @patch('deckbridge_sync.tooltip')
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.validate_token', return_value={'user': {'email': 'user@example.com'}, 'decks': []})
    @patch('deckbridge_sync.SettingsDialog')
    def test_pull_after_save_schedules_existing_pull_without_push(
        self,
        mock_dialog_class,
        _mock_validate,
        mock_save,
        mock_tooltip,
        mock_single_shot,
        mock_post_cards,
    ):
        dialog = MagicMock()
        dialog.exec.return_value = True
        dialog.values.return_value = {
            **DEFAULT_CONFIG,
            'platform_url': 'https://deckbridge.example/',
            'api_token': 'db_good',
        }
        dialog.pull_after_save.isChecked.return_value = True
        mock_dialog_class.return_value = dialog

        open_settings()

        saved = mock_save.call_args[0][0]
        self.assertEqual(saved['platform_url'], 'https://deckbridge.example')
        mock_tooltip.assert_called_once()
        mock_single_shot.assert_called_once_with(0, pull_to_anki)
        mock_post_cards.assert_not_called()


class TestHandleUrlScheme(unittest.TestCase):
    @patch('deckbridge_sync.QTimer.singleShot')
    @patch('deckbridge_sync.showInfo')
    @patch('deckbridge_sync.apply_autoconfig', return_value=True)
    def test_success_opens_settings_after_saved_message(self, mock_apply, mock_show, mock_single_shot):
        _handle_url_scheme('anki://deckbridge?url=https%3A%2F%2Fdeckbridge.example&token=db_good&deckId=deck-1')

        mock_apply.assert_called_once()
        message = mock_show.call_args[0][0]
        self.assertIn('configuration saved', message)
        self.assertIn('Settings will open', message)
        mock_single_shot.assert_called_once_with(0, open_settings)

    @patch('deckbridge_sync.QTimer.singleShot')
    @patch('deckbridge_sync.showInfo')
    @patch('deckbridge_sync.last_autoconfig_error', return_value='bad link')
    @patch('deckbridge_sync.apply_autoconfig', return_value=False)
    def test_failure_does_not_open_settings(self, _mock_apply, mock_error, mock_show, mock_single_shot):
        _handle_url_scheme('anki://deckbridge')

        mock_error.assert_called_once()
        self.assertIn('bad link', mock_show.call_args[0][0])
        mock_single_shot.assert_not_called()


class TestLocalDeckNames(unittest.TestCase):
    def test_uses_anki_deck_api_when_available(self):
        deck = MagicMock()
        deck.name = 'Boards::Neuro'
        aqt_mock.mw.col.decks.all_names_and_ids.return_value = [deck]
        self.assertEqual(local_deck_names(), ['Boards::Neuro'])


class TestNoteQuery(unittest.TestCase):
    def setUp(self):
        aqt_mock.mw.col.conf = {}

    @patch('deckbridge_sync.active_local_deck', return_value='Spanish')
    def test_basic_query(self, _mock_deck):
        aqt_mock.mw.addonManager.getConfig.return_value = {'tag_filter': '', 'include_suspended': True}
        query = note_query()
        self.assertIn('deck:"Spanish"', query)

    @patch('deckbridge_sync.active_local_deck', return_value='Spanish')
    def test_includes_tag_filter(self, _mock_deck):
        aqt_mock.mw.addonManager.getConfig.return_value = {'tag_filter': 'marked', 'include_suspended': True}
        query = note_query()
        self.assertIn('tag:"marked"', query)

    @patch('deckbridge_sync.active_local_deck', return_value='Spanish')
    def test_excludes_suspended(self, _mock_deck):
        aqt_mock.mw.addonManager.getConfig.return_value = {'tag_filter': '', 'include_suspended': False}
        query = note_query()
        self.assertIn('-is:suspended', query)


if __name__ == '__main__':
    unittest.main()
