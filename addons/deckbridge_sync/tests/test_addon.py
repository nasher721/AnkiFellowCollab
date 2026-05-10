import json
import os
import socket
import sys
import tempfile
import unittest
import urllib.error
import base64
import zlib
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
    collect_media_payload,
    DEFAULT_CONFIG,
    CONFIG_KEY,
    last_autoconfig_error,
    login_to_account,
    local_deck_names,
    media_refs_from_fields,
    normalize_platform_url,
    note_to_card,
    note_to_cards,
    open_settings,
    parse_deck_updates_response,
    fetch_deck_updates,
    pull_scheduling_from_platform,
    platform_url,
    post_cards,
    protocol_recovery_message,
    pull_to_anki,
    request_json,
    save_config,
    store_updates_checkpoint,
    safe_tag,
    sync_payload_chunks,
    tracking_tag,
    note_query,
    validate_token,
    TRACKING_TAG_PREFIX,
    _flat_from_stored,
    apply_scheduling_update,
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
        self.assertEqual(addon_manifest()['version'], '0.2.2')
        self.assertEqual(ADDON_VERSION, addon_manifest()['version'])


class FakeCard:
    def __init__(self, ord=0, due=0, queue=2):
        self.ord = ord
        self.due = due
        self.queue = queue
        self.type = 2
        self.ivl = 1
        self.factor = 2500
        self.reps = 0
        self.flushed = False

    def flush(self):
        self.flushed = True

    def question(self):
        return '<section id="front-section"><b>Front</b></section>'

    def answer(self):
        return '<section id="back">Back</section>'


class FakeNote:
    id = 101
    tags = ['DeckBridge']
    mod = 1760000000

    def __init__(self):
        self.card = FakeCard()
        self.values = {'Front': '<b>Front</b>', 'Back': 'Back'}

    def note_type(self):
        return {
            'name': 'Basic',
            'tmpls': [{'qfmt': '{{Front}}', 'afmt': '{{FrontSide}}<hr>{{Back}}'}],
            'css': '.card { color: red; }',
        }

    def keys(self):
        return self.values.keys()

    def __getitem__(self, key):
        return self.values[key]

    def __contains__(self, key):
        return key in self.values

    def cards(self):
        return [self.card]


class TestSchedulingSync(unittest.TestCase):
    def test_note_to_card_includes_model_template_and_css(self):
        card = note_to_card(FakeNote())

        self.assertEqual(card['id'], 'anki-101-0')
        self.assertEqual(card['templateFront'], '{{Front}}')
        self.assertEqual(card['templateBack'], '{{FrontSide}}<hr>{{Back}}')
        self.assertEqual(card['modelCss'], '.card { color: red; }')
        self.assertEqual(card['renderedFront'], '<section id="front-section"><b>Front</b></section>')
        self.assertEqual(card['renderedBack'], '<section id="back">Back</section>')
        self.assertEqual(card['clozeOrd'], 0)

    def test_note_to_cards_emits_one_card_per_anki_card_with_matching_template_ord(self):
        class MultiCardNote(FakeNote):
            def __init__(self):
                super().__init__()
                self.cards_list = [
                    FakeCard(ord=0, due=3, queue=0),
                    FakeCard(ord=1, due=9, queue=2),
                ]

            def note_type(self):
                return {
                    'name': 'Basic (and reversed card)',
                    'tmpls': [
                        {'qfmt': '{{Front}}', 'afmt': '{{FrontSide}}<hr>{{Back}}'},
                        {'qfmt': '{{Back}}', 'afmt': '{{FrontSide}}<hr>{{Front}}'},
                    ],
                    'css': '.card { color: blue; }',
                }

            def cards(self):
                return self.cards_list

        cards = note_to_cards(MultiCardNote())

        self.assertEqual([card['id'] for card in cards], ['anki-101-0', 'anki-101-1'])
        self.assertEqual([card['ankiNoteId'] for card in cards], [101, 101])
        self.assertEqual([card['clozeOrd'] for card in cards], [0, 1])
        self.assertEqual(cards[0]['templateFront'], '{{Front}}')
        self.assertEqual(cards[1]['templateFront'], '{{Back}}')
        self.assertEqual(cards[0]['state'], 'New')
        self.assertEqual(cards[1]['state'], 'Review')

    @patch('deckbridge_sync.mw')
    def test_apply_scheduling_update_sets_review_card_values(self, mock_mw):
        note = FakeNote()
        mock_mw.col.get_note.return_value = note
        mock_mw.col.sched.today = 100
        mock_mw.col.update_card.side_effect = lambda card: setattr(card, 'updated', True)

        result = apply_scheduling_update({
            'cardId': 'anki-101',
            'ankiNoteId': 101,
            'intervalDays': 12,
            'easeFactor': 2.6,
            'repetitions': 5,
            'nextDue': '2026-05-18T00:00:00.000Z',
        })

        self.assertEqual(result, 'updated')
        self.assertEqual(note.card.ivl, 12)
        self.assertEqual(note.card.factor, 2600)
        self.assertEqual(note.card.reps, 5)
        self.assertEqual(note.card.queue, 2)
        self.assertEqual(note.card.type, 2)
        self.assertGreaterEqual(note.card.due, 100)

    @patch('deckbridge_sync.apply_scheduling_update', side_effect=['updated', 'skipped'])
    @patch('deckbridge_sync.request_json')
    @patch('deckbridge_sync.config')
    def test_pull_scheduling_from_platform_counts_updates(self, mock_config, mock_request, _mock_apply):
        mock_config.return_value = {**DEFAULT_CONFIG, 'deck_id': 'deck-1'}
        mock_request.return_value = {'updates': [{'cardId': 'a'}, {'cardId': 'b'}]}

        result = pull_scheduling_from_platform()

        self.assertEqual(result, {'updated': 1, 'skipped': 1})
        self.assertEqual(mock_request.call_args[0][1], '/api/decks/deck-1/sync/scheduling')


class TestMediaSync(unittest.TestCase):
    def test_media_refs_from_fields_extracts_images_and_sounds(self):
        refs = media_refs_from_fields({
            'Front': '<div><img src="neuro%20image.png"><img src=https://example.com/remote.png></div>',
            'Back': '[sound:clip.mp3] <img src="data:image/png;base64,abc"> <img src="../nested/local.svg">',
            'Extra': '[sound:clip.mp3]',
        })

        self.assertEqual(refs, ['neuro image.png', 'clip.mp3', 'local.svg'])

    @patch('deckbridge_sync.media_dir')
    def test_collect_media_payload_reads_local_media_file(self, mock_media_dir):
        with tempfile.TemporaryDirectory() as media_root:
            mock_media_dir.return_value = media_root
            image_path = os.path.join(media_root, 'image.png')
            with open(image_path, 'wb') as image_file:
                image_file.write(b'png-bytes')

            payload = collect_media_payload([{
                'id': 'anki-1',
                'mediaRefs': ['image.png', 'missing.png', '../image.png'],
            }])

        self.assertEqual(list(payload.keys()), ['image.png'])
        self.assertEqual(payload['image.png']['mimeType'], 'image/png')
        self.assertEqual(payload['image.png']['sha256'], 'ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56')
        self.assertEqual(payload['image.png']['dataBase64'], 'cG5nLWJ5dGVz')

    @patch('deckbridge_sync.upload_media_file')
    @patch('deckbridge_sync.request_json')
    @patch('deckbridge_sync.media_dir')
    def test_collect_media_payload_uploads_large_media_file(self, mock_media_dir, mock_request, mock_upload):
        with tempfile.TemporaryDirectory() as media_root:
            mock_media_dir.return_value = media_root
            image_path = os.path.join(media_root, 'large.png')
            with open(image_path, 'wb') as image_file:
                image_file.write(b'x' * 800_000)

            expected_sha = 'cafb091ba391cae6f99dac0e615c4b76614b5bf6d8c33c70f5569b75bf8c3218'
            mock_request.return_value = {
                'uploads': [{
                    'filename': 'large.png',
                    'mimeType': 'image/png',
                    'sha256': expected_sha,
                    'sizeBytes': 800_000,
                    'storageBucket': 'deckbridge-media',
                    'storagePath': f'deck-1/{expected_sha}/large.png',
                    'uploadUrl': 'https://storage.example/upload/sign/large.png?token=signed',
                }]
            }

            payload = collect_media_payload(
                [{'id': 'anki-1', 'mediaRefs': ['large.png']}],
                cfg={**DEFAULT_CONFIG, 'deck_id': 'deck-1'},
                deck_id='deck-1',
                dry_run=False,
            )

        mock_request.assert_called_once()
        mock_upload.assert_called_once()
        self.assertEqual(payload['large.png']['storageBucket'], 'deckbridge-media')
        self.assertEqual(payload['large.png']['storagePath'], f'deck-1/{expected_sha}/large.png')
        self.assertNotIn('dataBase64', payload['large.png'])

    @patch('deckbridge_sync.media_dir', side_effect=RuntimeError('media unavailable'))
    def test_collect_media_payload_skips_inaccessible_media_dir(self, _mock_media_dir):
        self.assertEqual(collect_media_payload([{'id': 'anki-1', 'mediaRefs': ['image.png']}]), {})


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
        self.assertEqual(DEFAULT_CONFIG['timeout_seconds'], 120)
        self.assertEqual(DEFAULT_CONFIG['sync_on_profile_open'], False)
        self.assertEqual(DEFAULT_CONFIG['sync_on_close'], False)

    def test_legacy_local_default_is_migrated_to_hosted_url(self):
        flat = _flat_from_stored({'url': 'http://localhost:4175', 'deckMappings': []})
        self.assertEqual(flat['platform_url'], 'https://anki-collab.vercel.app')


class TestRequestTimeouts(unittest.TestCase):
    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_request_json_honors_configured_timeout_for_normal_api_calls(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse({'ok': True})

        result = request_json(
            'GET',
            '/api/me',
            cfg={**DEFAULT_CONFIG, 'api_token': '', 'timeout_seconds': 7},
        )

        self.assertEqual(result, {'ok': True})
        self.assertEqual(mock_urlopen.call_args.kwargs['timeout'], 7)

    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_request_json_uses_sync_timeout_floor_for_old_saved_configs(self, mock_urlopen):
        mock_urlopen.return_value = FakeResponse({'result': {'stats': {'created': 1}}})

        request_json(
            'POST',
            '/api/decks/deck-1/sync/cards',
            {'cards': [{'id': 'anki-1'}]},
            cfg={**DEFAULT_CONFIG, 'api_token': '', 'timeout_seconds': 30},
            timeout_floor=120,
        )

        self.assertEqual(mock_urlopen.call_args.kwargs['timeout'], 120)

    @patch('deckbridge_sync.urllib.request.urlopen', side_effect=socket.timeout('The read operation timed out'))
    def test_request_json_timeout_error_names_wait_and_retry_behavior(self, _mock_urlopen):
        with self.assertRaisesRegex(RuntimeError, r'timed out after 120 seconds.*try the push again.*smaller batch size'):
            request_json(
                'POST',
                '/api/decks/deck-1/sync/cards',
                {'cards': [{'id': 'anki-1'}]},
                cfg={**DEFAULT_CONFIG, 'api_token': '', 'timeout_seconds': 30},
                timeout_floor=120,
            )

    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_request_json_platform_500_does_not_report_unreachable(self, mock_urlopen):
        mock_urlopen.side_effect = http_error(500, {'detail': 'Unexpected server error'})

        with self.assertRaisesRegex(RuntimeError, r'DeckBridge API 500: DeckBridge platform error.*database migrations'):
            request_json(
                'POST',
                '/api/decks/sync/from-anki',
                {'cards': [{'id': 'anki-1', 'fields': {'Front': 'A'}}]},
                cfg={**DEFAULT_CONFIG, 'platform_url': 'https://deckbridge.example', 'api_token': 'db_token'},
                timeout_floor=120,
            )


class TestProtocolRecoveryMessages(unittest.TestCase):
    def test_invalid_token_message_names_reconnect(self):
        message = protocol_recovery_message(status=401, detail='invalid token')

        self.assertIn('invalid token', message)
        self.assertIn('Reconnect DeckBridge', message)
        self.assertIn('refresh the API token', message)

    def test_missing_deck_mapping_message_names_settings_action(self):
        message = protocol_recovery_message(detail='No DeckBridge deck mapping is configured.')

        self.assertIn('Choose a local Anki deck', message)
        self.assertIn('mapped DeckBridge deck', message)

    def test_conflict_message_preserves_detect_default_guidance(self):
        message = protocol_recovery_message(method='POST', path='/api/decks/deck-1/sync/cards', status=409, detail='conflict detected')

        self.assertIn('Review conflicts in DeckBridge', message)
        self.assertIn('conflictPolicy=detect', message)

    def test_media_target_message_names_retry_before_card_sync(self):
        message = protocol_recovery_message(method='POST', path='/api/decks/deck-1/media/uploads', detail='media upload target missing')

        self.assertIn('media upload target failed', message)
        self.assertIn('Retry media upload before card sync', message)

    def test_ssl_message_names_proxy_vpn_antivirus(self):
        message = protocol_recovery_message(method='GET', path='/api/me', detail='CERTIFICATE_VERIFY_FAILED')

        self.assertIn('secure HTTPS connection', message)
        self.assertIn('proxy', message)
        self.assertIn('VPN', message)
        self.assertIn('antivirus', message)

    def test_proxy_message_names_network_path(self):
        message = protocol_recovery_message(method='GET', path='/api/me', detail='proxy tunnel failed')

        self.assertIn('network path failed', message)
        self.assertIn('proxy or VPN', message)

    @patch('deckbridge_sync.urllib.request.urlopen')
    def test_request_json_conflict_uses_review_before_overwrite_wording(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url='https://deckbridge.example/api/decks/deck-1/sync/cards',
            code=409,
            msg='Conflict',
            hdrs={},
            fp=BytesIO(json.dumps({'error': {'message': 'conflict detected'}}).encode('utf-8')),
        )

        with self.assertRaisesRegex(RuntimeError, r'Review conflicts in DeckBridge.*conflictPolicy=detect'):
            request_json(
                'POST',
                '/api/decks/deck-1/sync/cards',
                {'cards': [{'id': 'anki-1'}]},
                cfg={**DEFAULT_CONFIG, 'platform_url': 'https://deckbridge.example', 'api_token': 'db_token'},
            )

    @patch('deckbridge_sync.urllib.request.urlopen', side_effect=urllib.error.URLError('connection refused'))
    def test_request_json_unreachable_mentions_vpn_proxy_antivirus(self, _mock_urlopen):
        with self.assertRaisesRegex(RuntimeError, r'VPN/proxy/antivirus'):
            request_json(
                'GET',
                '/api/me',
                cfg={**DEFAULT_CONFIG, 'platform_url': 'https://deckbridge.example', 'api_token': 'db_token'},
            )


class TestDeckUpdatesCheckpoint(unittest.TestCase):
    def setUp(self):
        aqt_mock.mw.col.conf = {}
        aqt_mock.mw.addonManager.getConfig.return_value = None

    def test_parse_deck_updates_response_uses_updates_and_checkpoint(self):
        parsed = parse_deck_updates_response({
            'updates': [{'cardId': 'card-1'}],
            'nextCheckpoint': '2026-05-09T10:00:00.000Z',
        })

        self.assertEqual(parsed['updates'], [{'cardId': 'card-1'}])
        self.assertEqual(parsed['checkpoint'], '2026-05-09T10:00:00.000Z')

    def test_parse_deck_updates_response_can_fallback_to_sync_proof_timestamp(self):
        parsed = parse_deck_updates_response({
            'changes': [{'type': 'card.updated'}],
            'syncProof': {'timestamp': '2026-05-09T11:00:00.000Z'},
        })

        self.assertEqual(parsed['updates'], [{'type': 'card.updated'}])
        self.assertEqual(parsed['checkpoint'], '2026-05-09T11:00:00.000Z')

    def test_parse_deck_updates_response_rejects_invalid_updates(self):
        with self.assertRaisesRegex(RuntimeError, 'invalid updates list'):
            parse_deck_updates_response({'updates': {'cardId': 'card-1'}})

    def test_store_updates_checkpoint_persists_by_deck_id(self):
        aqt_mock.mw.col.conf = {
            CONFIG_KEY: {
                'url': 'https://deckbridge.example',
                'token': 'db_token',
                'deckMappings': [{'localDeck': 'Local Deck', 'deckId': 'deck-1', 'conflictPolicy': 'detect'}],
            }
        }

        store_updates_checkpoint('deck-1', '2026-05-09T12:00:00.000Z')

        stored = aqt_mock.mw.col.conf[CONFIG_KEY]
        self.assertEqual(stored['updateCheckpoints']['deck-1'], '2026-05-09T12:00:00.000Z')

    @patch('deckbridge_sync.request_json')
    def test_fetch_deck_updates_passes_since_and_stores_checkpoint(self, mock_request):
        aqt_mock.mw.col.conf = {
            CONFIG_KEY: {
                'url': 'https://deckbridge.example',
                'token': 'db_token',
                'deckMappings': [{'localDeck': 'Local Deck', 'deckId': 'deck-1', 'conflictPolicy': 'detect'}],
                'updateCheckpoints': {'deck-1': '2026-05-09T12:00:00.000Z'},
            }
        }
        mock_request.return_value = {
            'updates': [{'cardId': 'card-1'}],
            'checkpoint': '2026-05-09T13:00:00.000Z',
        }

        parsed = fetch_deck_updates(config())

        self.assertEqual(parsed['updates'], [{'cardId': 'card-1'}])
        self.assertIn('/api/decks/deck-1/updates?since=2026-05-09T12%3A00%3A00.000Z', mock_request.call_args[0][1])
        self.assertEqual(aqt_mock.mw.col.conf[CONFIG_KEY]['updateCheckpoints']['deck-1'], '2026-05-09T13:00:00.000Z')


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
    @patch('deckbridge_sync.collect_cards', return_value=[{'id': 'anki-1', 'fields': {'Front': 'A'}}])
    @patch('deckbridge_sync.request_json')
    @patch('deckbridge_sync.config', return_value={**DEFAULT_CONFIG, 'local_deck': 'Local Deck'})
    def test_create_platform_deck_from_anki_saves_returned_deck_id(self, _mock_config, mock_request, _mock_collect, mock_save):
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

    @patch('deckbridge_sync.config')
    def test_sync_payload_chunks_honors_batch_size(self, mock_config):
        cfg = {**DEFAULT_CONFIG, 'local_deck': 'Local Deck', 'batch_size': 2}
        mock_config.return_value = cfg
        cards = [{'id': f'anki-{index}', 'fields': {'Front': str(index)}} for index in range(5)]

        payloads = sync_payload_chunks(cards, dry_run=False, cfg=cfg)

        self.assertEqual(len(payloads), 3)
        self.assertEqual([len(payload['cards']) for payload in payloads], [2, 2, 1])
        self.assertEqual(payloads[0]['batch']['index'], 0)
        self.assertEqual(payloads[2]['batch']['total'], 3)
        self.assertEqual(payloads[2]['batch']['totalCards'], 5)

    @patch('deckbridge_sync.config')
    def test_sync_payload_chunks_splits_by_request_size(self, mock_config):
        cfg = {**DEFAULT_CONFIG, 'local_deck': 'Local Deck', 'batch_size': 5000}
        mock_config.return_value = cfg
        cards = [{'id': f'anki-{index}', 'fields': {'Front': f'{index}-' + ('A' * 50_000)}} for index in range(80)]

        payloads = sync_payload_chunks(cards, dry_run=False, cfg=cfg)

        self.assertGreater(len(payloads), 1)
        self.assertEqual(sum(len(payload['cards']) for payload in payloads), 80)
        for payload in payloads:
            self.assertLessEqual(len(json.dumps(payload, separators=(',', ':')).encode('utf-8')), 3_500_000)

    @patch('deckbridge_sync.config')
    def test_sync_payload_chunks_compresses_oversized_single_note_fields(self, mock_config):
        cfg = {**DEFAULT_CONFIG, 'local_deck': 'Local Deck', 'batch_size': 5000}
        mock_config.return_value = cfg
        large_field = '<div class="explanation">nimodipine pearl</div>' * 100_000
        cards = [{'id': 'anki-large', 'fields': {'Text': large_field, 'Extra': 'keep me'}}]

        payloads = sync_payload_chunks(cards, dry_run=False, cfg=cfg)

        self.assertEqual(len(payloads), 1)
        card = payloads[0]['cards'][0]
        self.assertEqual(card['fields']['Text'], '')
        self.assertEqual(card['fields']['Extra'], 'keep me')
        compressed = card['compressedFields']['Text']
        decoded = zlib.decompress(base64.b64decode(compressed['data'])).decode('utf-8')
        self.assertEqual(decoded, large_field)
        self.assertFalse(payloads[0]['returnState'])
        self.assertLess(len(json.dumps(payloads[0], separators=(',', ':')).encode('utf-8')), 3_500_000)

    @patch('deckbridge_sync.request_json')
    @patch('deckbridge_sync.validate_token')
    @patch('deckbridge_sync.collect_cards')
    @patch('deckbridge_sync.config')
    def test_post_cards_sends_chunks_and_aggregates_result(self, mock_config, mock_collect, mock_validate, mock_request):
        cfg = {**DEFAULT_CONFIG, 'platform_url': 'https://deckbridge.example', 'api_token': 'db_token', 'deck_id': 'deck-1', 'local_deck': 'Local Deck', 'batch_size': 1}
        mock_config.return_value = cfg
        mock_collect.return_value = [
            {'id': 'anki-1', 'fields': {'Front': 'A'}},
            {'id': 'anki-2', 'fields': {'Front': 'B'}},
        ]
        mock_validate.return_value = {'decks': [{'id': 'deck-1'}]}
        mock_request.side_effect = [
            {'result': {'stats': {'total': 1, 'created': 1, 'updated': 0, 'skipped': 0, 'conflicts': 0, 'dryRun': False}, 'conflicts': []}},
            {'result': {'stats': {'total': 1, 'created': 0, 'updated': 1, 'skipped': 0, 'conflicts': 0, 'dryRun': False}, 'conflicts': []}},
        ]

        result = post_cards(dry_run=False)

        self.assertEqual(mock_request.call_count, 2)
        self.assertEqual(result['result']['stats']['total'], 2)
        self.assertEqual(result['result']['stats']['created'], 1)
        self.assertEqual(result['result']['stats']['updated'], 1)
        self.assertEqual(mock_request.call_args_list[0][0][1], '/api/decks/deck-1/sync/cards')

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
