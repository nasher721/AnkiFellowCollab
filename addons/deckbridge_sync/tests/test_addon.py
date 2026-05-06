import json
import os
import sys
import unittest
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
    apply_autoconfig,
    config,
    DEFAULT_CONFIG,
    platform_url,
    safe_tag,
    tracking_tag,
    note_query,
    TRACKING_TAG_PREFIX,
)


class TestApplyAutoconfig(unittest.TestCase):
    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_parses_valid_url_returns_true(self, mock_config, mock_save):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = 'anki://deckbridge?url=https%3A%2F%2Fdeckbridge.com&token=db_abc123&deckId=deck-1'
        result = apply_autoconfig(url)
        self.assertTrue(result)
        saved = mock_save.call_args[0][0]
        self.assertEqual(saved['platform_url'], 'https://deckbridge.com')
        self.assertEqual(saved['api_token'], 'db_abc123')
        self.assertEqual(saved['deck_id'], 'deck-1')

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

    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_optional_deck_id_omitted(self, mock_config, mock_save):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = 'anki://deckbridge?url=https%3A%2F%2Fexample.com&token=db_tok'
        result = apply_autoconfig(url)
        self.assertTrue(result)
        saved = mock_save.call_args[0][0]
        self.assertEqual(saved['platform_url'], 'https://example.com')
        self.assertEqual(saved['api_token'], 'db_tok')
        self.assertEqual(saved['deck_id'], DEFAULT_CONFIG['deck_id'])

    @patch('deckbridge_sync.save_config')
    @patch('deckbridge_sync.config')
    def test_blank_params_treated_as_missing(self, mock_config, mock_save):
        mock_config.return_value = DEFAULT_CONFIG.copy()
        url = 'anki://deckbridge?url=&token=   '
        result = apply_autoconfig(url)
        self.assertFalse(result)


class TestDefaultConfig(unittest.TestCase):
    def test_has_required_fields(self):
        required = [
            'platform_url', 'api_token', 'deck_id', 'local_deck',
            'conflict_policy', 'auto_sync_minutes', 'timeout_seconds',
            'batch_size', 'tag_filter', 'include_suspended',
            'create_missing_notes', 'pull_overwrites_local',
            'sync_on_profile_open', 'sync_on_close',
        ]
        for field in required:
            self.assertIn(field, DEFAULT_CONFIG, f"Missing field: {field}")

    def test_defaults(self):
        self.assertEqual(DEFAULT_CONFIG['platform_url'], 'http://localhost:4175')
        self.assertEqual(DEFAULT_CONFIG['api_token'], '')
        self.assertEqual(DEFAULT_CONFIG['deck_id'], 'deck-demo-zanki')
        self.assertEqual(DEFAULT_CONFIG['local_deck'], '')
        self.assertEqual(DEFAULT_CONFIG['conflict_policy'], 'detect')
        self.assertEqual(DEFAULT_CONFIG['auto_sync_minutes'], 0)
        self.assertEqual(DEFAULT_CONFIG['sync_on_profile_open'], False)
        self.assertEqual(DEFAULT_CONFIG['sync_on_close'], False)


class TestPlatformUrl(unittest.TestCase):
    def test_joins_path(self):
        cfg = {'platform_url': 'http://localhost:4175'}
        self.assertEqual(platform_url(cfg, '/api/me'), 'http://localhost:4175/api/me')

    def test_strips_trailing_slash(self):
        cfg = {'platform_url': 'http://localhost:4175/'}
        self.assertEqual(platform_url(cfg, '/api/me'), 'http://localhost:4175/api/me')


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
    def test_merges_stored_over_defaults(self):
        aqt_mock.mw.addonManager.getConfig.return_value = {'api_token': 'stored_tok'}
        result = config()
        self.assertEqual(result['api_token'], 'stored_tok')
        self.assertEqual(result['platform_url'], DEFAULT_CONFIG['platform_url'])

    def test_returns_defaults_when_no_stored(self):
        aqt_mock.mw.addonManager.getConfig.return_value = None
        result = config()
        self.assertEqual(result, DEFAULT_CONFIG)


class TestNoteQuery(unittest.TestCase):
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
