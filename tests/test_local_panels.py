"""Unit/dry-run tests: never start Docker, bind external ports, or edit /opt."""
import copy
import io
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/local-panels.py"
spec = importlib.util.spec_from_file_location("local_panels", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def state():
    return {"instance": "test", "providers": {
        "3xui": {"image": "ghcr.io/mhsanaei/3x-ui:v3.7.0", "version": "v3.7.0", "mode": "domain", "host": "xui.example.com", "vpn_ports": ["8443/tcp", "8443/udp"]},
        "remnawave": {"image": "remnawave/backend:3.4.3", "version": "3.4.3", "mode": "domain", "host": "rw.example.com", "pg_image": "postgres:18.4", "redis_image": "valkey/valkey:9-alpine", "pg_target": "/var/lib/postgresql"},
    }}


class LocalPanelsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "providers"
        self.app = Path(self.temp.name) / "nexus"
        self.app.mkdir()
        self.args = SimpleNamespace(instance="test", app_dir=str(self.app), panel_domain="nexus.example.com", sub_domain="sub.example.com", app_port=3000, bind_ip="", caddy_container="nexus-test-caddy", has_web_proxy=True)

    def save(self, s=None):
        m.private_write(self.root / "state.json", json.dumps(s or state()))

    def prepare_ports(self):
        self.save()
        m.private_write(self.root / "docker-compose.yml", json.dumps(m.provider_compose(state(), self.root)))
        override = self.app / "docker-compose.override.yml"
        m.private_write(override, json.dumps(m.proxy_override(state(), self.root, True)))
        m.private_write(self.root / "override-managed", m.hashlib.sha256(override.read_bytes()).hexdigest())

    def test_publish_inbound_port_preserves_old_ports_and_updates_nexus(self):
        self.prepare_ports()
        with patch.object(m, "ask", side_effect=["28140/tcp", "ДА"]), patch.object(m, "assert_ports_free") as free, patch.object(m, "run", return_value="") as run:
            m.configure_vpn_ports(self.args, self.root)
        free.assert_called_once_with([(28140, "tcp")])
        item = m.load_state(self.root, "test")["providers"]["3xui"]
        self.assertEqual(item["vpn_ports"], ["8443/tcp", "8443/udp", "28140/tcp"])
        config = json.loads((self.app / "docker-compose.override.yml").read_text())
        self.assertIn("28140/tcp", config["services"]["aggregator"]["environment"]["NEXUS_LOCAL_XUI_VPN_PORTS"])
        self.assertTrue(any(call.args[0][-1] == "local-3xui" for call in run.call_args_list))
        self.assertFalse(any("caddy" in call.args[0] or "remnawave" in call.args[0] for call in run.call_args_list))

    def test_publish_ports_rolls_back_on_docker_failure(self):
        self.prepare_ports()
        paths = [self.root / "state.json", self.root / "docker-compose.yml", self.app / "docker-compose.override.yml", self.root / "override-managed"]
        before = {p: p.read_bytes() for p in paths}
        with patch.object(m, "ask", side_effect=["28140/tcp", "ДА"]), patch.object(m, "assert_ports_free"), patch.object(m, "run", side_effect=["", "", RuntimeError("failed"), "", ""]):
            with self.assertRaises(RuntimeError):
                m.configure_vpn_ports(self.args, self.root)
        self.assertEqual(before, {p: p.read_bytes() for p in paths})

    def test_publish_ports_enter_does_not_generate_a_random_port(self):
        self.prepare_ports()
        with patch.object(m, "ask", return_value=""), patch.object(m, "run") as run:
            m.configure_vpn_ports(self.args, self.root)
        run.assert_not_called()

    def test_publish_ports_rejects_occupied_port(self):
        self.prepare_ports()
        before = (self.root / "state.json").read_bytes()
        with patch.object(m, "ask", return_value="2053/tcp"), patch.object(m, "assert_ports_free", side_effect=ValueError("busy")), patch.object(m, "run") as run:
            with self.assertRaises(ValueError):
                m.configure_vpn_ports(self.args, self.root)
        run.assert_not_called()
        self.assertEqual(before, (self.root / "state.json").read_bytes())

    def test_releases_filter_dev_drafts_and_take_five(self):
        rows = [{"tag_name": "dev-latest", "prerelease": True}, {"tag_name": "v9.0.0", "draft": True}] + [{"tag_name": "v3.7." + str(i)} for i in range(6)]
        with patch.object(m, "fetch", return_value=json.dumps(rows)):
            self.assertEqual(m.stable_releases("3xui"), ["v3.7." + str(i) for i in range(5)])

    def test_catalog_empty_is_error_not_guessed_latest(self):
        with patch.object(m, "fetch", return_value="[]"):
            with self.assertRaises(ValueError): m.stable_releases("remnawave")

    def test_manual_release_resolves_v_prefix(self):
        missing = urllib.error.HTTPError("https://api.github.com", 404, "Not found", {}, None)
        with patch.object(m, "fetch", side_effect=[missing, json.dumps({"tag_name": "v3.7.0"})]):
            self.assertEqual(m.resolve_release("3xui", "3.7.0"), "v3.7.0")

    def test_release_does_not_accept_url_shell_or_prerelease(self):
        for value in ("$(id)", "../main", "latest", "https://evil.test", "3.0.0-beta"):
            with self.assertRaises(ValueError): m.resolve_release("3xui", value)
        with patch.object(m, "fetch", return_value=json.dumps({"tag_name": "v3.7.0", "prerelease": True})):
            with self.assertRaises(ValueError): m.resolve_release("3xui", "v3.7.0")

    def test_latest_and_recent_menu(self):
        with patch.object(m, "stable_releases", return_value=["v3.7.0", "v3.6.0"]), patch.object(m, "ask", return_value="0"):
            self.assertEqual(m.choose_version("3xui"), "v3.7.0")
        with patch.object(m, "stable_releases", return_value=["v3.7.0", "v3.6.0"]), patch.object(m, "ask", return_value="2"):
            self.assertEqual(m.choose_version("3xui"), "v3.6.0")

    def test_domain_input_rejects_config_injection_and_ip(self):
        self.assertEqual(m.domain("XUI.Example.com."), "xui.example.com")
        for value in ("x.com {", "x.com\nimport bad", "https://x.com", "x.com/path", "x.com:443", "1.2.3.4", "-bad.example.com"):
            with self.assertRaises(ValueError): m.domain(value)

    def test_port_input_is_bounded_and_explicit_protocol(self):
        self.assertEqual(m.vpn_ports("8443/tcp, 8443/udp,8443/tcp"), ["8443/tcp", "8443/udp"])
        for value in ("443/tcp", "65536/tcp", "8443", "8000-9000/tcp", "8443/sctp"):
            with self.assertRaises(ValueError): m.vpn_ports(value)

    def test_host_port_conflicts_abort_without_stopping_any_service(self):
        with patch.object(m.socket, "socket") as factory:
            factory.return_value.bind.side_effect = OSError("in use")
            with self.assertRaisesRegex(ValueError, "занят"): m.assert_ports_free([(8443, "udp")])
            factory.return_value.close.assert_called_once()

    def test_enter_selects_default_free_xray_port(self):
        with patch('builtins.input', return_value=''), patch.object(m, 'assert_ports_free') as check:
            self.assertEqual(m.choose_ports('Xray', 8443, ('tcp', 'udp'), {3000}), [(8443, 'tcp'), (8443, 'udp')])
            check.assert_called_once_with([(8443, 'tcp'), (8443, 'udp')])

    def test_auto_skips_reserved_and_busy_ports(self):
        with patch('builtins.input', return_value=''), patch.object(m, 'assert_ports_free', side_effect=[ValueError('busy'), None]) as check:
            self.assertEqual(m.choose_ports('HTTPS', 2053, ('tcp',), {2053}), [(2055, 'tcp')])
            self.assertEqual(check.call_args_list[0].args[0], [(2054, 'tcp')])

    def test_bare_manual_vpn_port_expands_both_protocols(self):
        with patch('builtins.input', return_value='32669'), patch.object(m, 'assert_ports_free'):
            self.assertEqual(m.choose_ports('Xray', 8443, ('tcp', 'udp'), set()), [(32669, 'tcp'), (32669, 'udp')])

    def test_invalid_and_reserved_manual_input_reprompts(self):
        with patch('builtins.input', side_effect=['bad', '3000', '2053/udp', '']), patch.object(m, 'assert_ports_free'):
            self.assertEqual(m.choose_ports('HTTPS', 2053, ('tcp',), {3000}), [(2053, 'tcp')])

    def test_auto_exhaustion_allows_manual_retry(self):
        with patch('builtins.input', side_effect=['', '32669']), patch.object(m, 'assert_ports_free'):
            self.assertEqual(m.choose_ports('HTTPS', 2053, ('tcp',), set(range(2053, 2309))), [(32669, 'tcp')])

    def test_port_prompt_eof_cancels(self):
        with patch('builtins.input', side_effect=EOFError), patch.object(m, 'assert_ports_free') as check:
            with self.assertRaises(EOFError): m.choose_ports('HTTPS', 2053, ('tcp',), set())
            check.assert_not_called()

    def test_provider_networks_isolate_database_and_no_admin_public_ports(self):
        config = m.provider_compose(state(), self.root)
        self.assertEqual(config["name"], "nexus-local-test")
        self.assertEqual(config["services"]["local-3xui"]["ports"], ["8443:8443/tcp", "8443:8443/udp"])
        for name in ("local-remnawave", "remnawave-db", "remnawave-redis"):
            self.assertNotIn("ports", config["services"][name])
        self.assertEqual(config["services"]["remnawave-db"]["networks"], ["db"])
        self.assertTrue(config["networks"]["db"]["internal"])
        self.assertNotIn("privileged", config["services"]["local-3xui"])
        self.assertNotIn("network_mode", config["services"]["local-3xui"])

    def test_proxy_merges_existing_caddy_without_second_listener(self):
        result = m.proxy_override(state(), self.root, True)
        self.assertNotIn("image", result["services"]["caddy"])
        self.assertEqual([p["target"] for p in result["services"]["caddy"]["ports"]], [80, 443])
        self.assertTrue(result["networks"]["nexus-local"]["external"])
        self.assertIn("nexus-local", result["services"]["aggregator"]["networks"])

    def test_ip_nexus_can_gain_caddy_and_ip_tls_for_xui(self):
        s = state(); s["providers"].pop("remnawave")
        s["providers"]["3xui"].update(mode="ip", host="2001:db8::1", port=2053)
        result = m.proxy_override(s, self.root, False)
        self.assertEqual([p["target"] for p in result["services"]["caddy"]["ports"]], [2053])
        self.assertEqual(result["services"]["caddy"]["image"], "caddy:2")
        self.assertIn("https://[2001:db8::1]:2053", m.caddy_sites(s))
        self.assertIn("tls internal", m.caddy_sites(s))
        self.assertEqual(result['services']['aggregator']['environment']['NEXUS_LOCAL_XUI_PUBLIC_HOST'], '2001:db8::1')

    def test_vpn_endpoint_is_distinct_from_panel_domain(self):
        s = state(); s['providers']['3xui']['vpn_host'] = '203.0.113.50'
        config = m.proxy_override(s, self.root, True)
        self.assertEqual(config['services']['aggregator']['environment']['NEXUS_LOCAL_XUI_PUBLIC_HOST'], '203.0.113.50')
        self.assertIn('xui.example.com', m.caddy_sites(s))
        self.assertNotIn('203.0.113.50', m.caddy_sites(s))

    def test_public_ip_certificate_uses_http_challenge_and_capable_caddy(self):
        s = state(); s['providers'].pop('remnawave')
        s['providers']['3xui'].update(mode='ip', host='8.8.8.8', port=2053, certificate='public')
        text = m.caddy_sites(s)
        self.assertIn('profile shortlived', text)
        self.assertIn('disable_tlsalpn_challenge', text)
        self.assertIn('http://8.8.8.8', text)
        self.assertNotIn('tls internal', text)
        config = m.proxy_override(s, self.root, True)
        self.assertEqual(config['services']['caddy']['image'], 'caddy:2.11.0')
        self.assertEqual([p['target'] for p in config['services']['caddy']['ports']], [80, 2053])

    def test_private_ip_cannot_request_public_certificate(self):
        s = state(); s['providers']['3xui'].update(mode='ip', host='192.168.1.2', port=2053, certificate='public')
        with self.assertRaises(ValueError): m.caddy_sites(s)

    def certificate_fixture(self):
        self.xui_fixture()
        (self.app / '.env').write_text('PORT=3000\nPANEL_PUBLIC_URL=https://nexus.example.com\nSUB_PUBLIC_URL=https://sub.example.com\n')
        (self.app / 'docker-compose.yml').write_text('services:\n  caddy:\n    image: caddy:2\n')
        (self.app / 'Caddyfile').write_text('nexus.example.com {\n reverse_proxy aggregator:3000\n}\n')
        m.render(self.args, self.root)

    def test_certificate_cancel_preserves_state(self):
        self.certificate_fixture()
        before = (self.root / 'state.json').read_bytes()
        with patch.object(m, 'ask', side_effect=['1', 'new.example.com', 'НЕТ']), patch.object(m, 'run', return_value='{"services":{"caddy":{"ports":[{"published":"80"},{"published":"443"}]}}}') as run:
            m.configure_certificate(self.args, self.root)
        self.assertEqual((self.root / 'state.json').read_bytes(), before)
        self.assertEqual(run.call_count, 1)

    def test_certificate_failed_pull_restores_all_configs_without_stopping_nexus(self):
        self.certificate_fixture()
        targets = [self.root / 'state.json', self.app / 'Caddyfile', self.app / 'docker-compose.override.yml', self.root / 'override-managed', self.root / 'sites/panels.caddy']
        before = {p: p.read_bytes() for p in targets}
        with patch.object(m, 'ask', side_effect=['1', 'new.example.com', 'ДА']), patch.object(m, 'run', side_effect=['{"services":{"caddy":{"ports":[{"published":"80"},{"published":"443"}]}}}', '', RuntimeError('pull failed')]) as run:
            with self.assertRaises(RuntimeError): m.configure_certificate(self.args, self.root)
        self.assertEqual(before, {p: p.read_bytes() for p in targets})
        self.assertFalse(any('stop' in c.args[0] or 'down' in c.args[0] for c in run.call_args_list))

    def test_certificate_success_recreates_only_caddy(self):
        self.certificate_fixture()
        with patch.object(m, 'ask', side_effect=['1', 'new.example.com', 'ДА']), patch.object(m, 'show_credentials'), patch.object(m, 'run', side_effect=['{"services":{"caddy":{"ports":[{"published":"80"},{"published":"443"}]}}}', '', '', '{}', '']) as run:
            m.configure_certificate(self.args, self.root)
        self.assertEqual(run.call_args_list[-1].args[0][-5:], ['up', '-d', '--no-deps', '--force-recreate', 'caddy'])
        self.assertEqual(json.loads((self.root / 'state.json').read_text())['providers']['3xui']['host'], 'new.example.com')
        self.assertEqual(json.loads((self.root / 'state.json').read_text())['providers']['3xui']['vpn_host'], 'xui.example.com')

    def test_duplicate_panel_domains_and_nexus_ports_fail(self):
        s = state(); s["providers"]["3xui"]["host"] = self.args.panel_domain
        with self.assertRaises(ValueError): m.validate_names(s, self.args)
        s["providers"]["3xui"].update(mode="ip", host="192.0.2.1", port=3000)
        with self.assertRaises(ValueError): m.validate_names(s, self.args)

    def test_default_sni_ip_ipv6_and_idempotent(self):
        for host in ('192.0.2.1', '2001:db8::1'):
            s = state(); s['providers']['3xui'].update(mode='ip', host=host, port=2053)
            text = '{\n    email admin@example.com\n}\nnexus.example.com {\n}\n'
            result = m.caddy_default_sni(text, s)
            self.assertIn('default_sni ' + host, result)
            self.assertEqual(result.count('default_sni '), 1)
            self.assertEqual(m.caddy_default_sni(result, s), result)
            self.assertIn('email admin@example.com', result)

    def test_default_sni_supports_no_global_block_and_preserves_manual_fix(self):
        s = state(); s['providers']['3xui'].update(mode='ip', host='192.0.2.1', port=2053)
        result = m.caddy_default_sni('import /etc/caddy/nexus-local/*.caddy\n', s)
        self.assertTrue(result.startswith('{\n    default_sni 192.0.2.1'))
        manual = '{\n default_sni 192.0.2.1\n}\n'
        self.assertEqual(m.caddy_default_sni(manual, s), manual)
        with self.assertRaises(ValueError): m.caddy_default_sni('{\n default_sni other.example.com\n}\n', s)

    def test_managed_sni_updates_when_ip_changes_and_domains_stay_unchanged(self):
        s = state(); s['providers']['3xui'].update(mode='ip', host='192.0.2.1', port=2053)
        rendered = m.caddy_default_sni('{\n email admin@example.com\n}\n', s)
        s['providers']['3xui']['host'] = '192.0.2.2'
        rendered = m.caddy_default_sni(rendered, s)
        self.assertNotIn('192.0.2.1', rendered)
        self.assertIn('default_sni 192.0.2.2', rendered)
        self.assertNotIn('default_sni', m.caddy_default_sni(rendered, state()))
        self.assertEqual(m.caddy_default_sni('example.com {\n}\n', state()), 'example.com {\n}\n')

    def test_caddy_render_recreates_ip_fix_after_update(self):
        s = state(); s['providers']['3xui'].update(mode='ip', host='192.0.2.1', port=2053)
        self.save(s)
        (self.app / 'docker-compose.yml').write_text('services:\n  caddy:\n    image: caddy:2\n')
        original = '{\n auto_https disable_redirects\n}\nnexus.example.com {\n}\n'
        for _ in range(2):
            (self.app / 'Caddyfile').write_text(original)
            m.render(self.args, self.root)
            self.assertIn('default_sni 192.0.2.1', (self.app / 'Caddyfile').read_text())

    def xui_fixture(self):
        self.save()
        m.private_write(self.root / '3xui/credentials.json', json.dumps({'username': 'user', 'password': 'old-secret', 'path': '/base/'}))
        (self.root / '3xui/db').mkdir()
        (self.root / '3xui/db/x-ui.db').write_text('test database')

    def test_cli_aliases_are_installed_idempotently_and_native_command_is_preserved(self):
        self.save()
        bin_dir = Path(self.temp.name) / 'bin'; bin_dir.mkdir()
        (bin_dir / 'x-ui').write_text('# native x-ui menu\n')
        with patch.object(m, 'require_admin'), patch.object(m.shutil, 'which', return_value=None):
            m.install_xui_cli(self.args, self.root, bin_dir)
            m.install_xui_cli(self.args, self.root, bin_dir)
        self.assertEqual((bin_dir / 'x-ui').read_text(), '# native x-ui menu\n')
        self.assertIn('--xui-action "${1:-menu}"', (bin_dir / 'xui').read_text())
        self.assertIn('Nexus managed x-ui CLI: test', (bin_dir / 'x-ui-test').read_text())

    def test_cli_never_shadows_native_command_elsewhere_in_path(self):
        self.save(); bin_dir = Path(self.temp.name) / 'bin'
        with patch.object(m, 'require_admin'), patch.object(m.shutil, 'which', side_effect=lambda name: '/usr/bin/x-ui' if name == 'x-ui' else None):
            m.install_xui_cli(self.args, self.root, bin_dir)
        self.assertFalse((bin_dir / 'x-ui').exists())
        self.assertTrue((bin_dir / 'x-ui-test').exists())

    def test_menu_enter_exits_without_mutation(self):
        self.save()
        with patch.object(m, 'require_admin'), patch('builtins.input', return_value=''), patch.object(m, 'run') as run:
            m.xui_action(self.args, self.root, 'menu')
        run.assert_not_called()

    def test_cli_requires_root_before_docker_or_secret_output(self):
        with patch.object(m.os, 'geteuid', return_value=1000, create=True), patch.object(m, 'run') as run:
            with self.assertRaises(ValueError): m.xui_action(self.args, self.root, 'credentials')
        run.assert_not_called()

    def test_remnawave_only_does_not_install_xui_commands(self):
        s = state(); s['providers'].pop('3xui'); self.save(s)
        bin_dir = Path(self.temp.name) / 'bin'
        with patch.object(m, 'require_admin'):
            m.install_xui_cli(self.args, self.root, bin_dir)
        self.assertFalse(bin_dir.exists())

    def test_rejected_stop_does_not_stop_any_service(self):
        self.save()
        with patch.object(m, 'require_admin'), patch.object(m, 'ask', return_value='НЕТ'), patch.object(m, 'run') as run:
            m.xui_action(self.args, self.root, 'stop')
        run.assert_not_called()

    def test_cli_status_targets_only_xui(self):
        self.save()
        with patch.object(m, 'require_admin'), patch.object(m, 'run') as run:
            m.xui_action(self.args, self.root, 'status')
        command = run.call_args.args[0]
        self.assertEqual(command[-3:], ['ps', '-a', 'local-3xui'])
        self.assertNotIn('pull', command)

    def test_credentials_no_tty_does_not_leak_or_generate_token(self):
        self.xui_fixture()
        output = io.StringIO()
        with patch.object(m, 'require_admin'), patch('builtins.open', side_effect=OSError('no tty')), patch.object(m, 'run') as run, contextlib.redirect_stdout(output):
            m.show_credentials(self.args, self.root)
        self.assertNotIn('old-secret', output.getvalue())
        run.assert_not_called()

    def test_credentials_only_go_to_tty_and_status_does_not_leak(self):
        self.xui_fixture()
        class Terminal(io.StringIO):
            def close(self): pass
        terminal = Terminal(); output = io.StringIO()
        with patch.object(m, 'require_admin'), patch('builtins.open', return_value=terminal), patch.object(m, 'run') as run, contextlib.redirect_stdout(output):
            m.show_credentials(self.args, self.root)
            m.status(self.args, self.root)
        self.assertIn('old-secret', terminal.getvalue())
        self.assertNotIn('old-secret', output.getvalue())
        run.assert_not_called()

    def test_password_change_backup_and_credentials_persist(self):
        self.xui_fixture()
        with patch.object(m, 'ask', side_effect=['new-user', 'ДА']), patch.object(m.getpass, 'getpass', return_value='new-password-123'), patch.object(m, 'show_credentials'), patch.object(m, 'run', side_effect=['container-id', '', 'Username and password updated successfully', '']) as run:
            m.xui_change(self.args, self.root, 'password')
        saved = json.loads((self.root / '3xui/credentials.json').read_text())
        self.assertEqual(saved['password'], 'new-password-123')
        self.assertEqual(saved['username'], 'new-user')
        self.assertEqual(run.call_args_list[1].args[0][-2:], ['stop', 'local-3xui'])
        self.assertEqual(run.call_args_list[-1].args[0][-2:], ['start', 'local-3xui'])
        backups = list(self.root.glob('xui-settings-backup-*/db/x-ui.db'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), 'test database')

    def test_failed_password_change_keeps_saved_secret_and_restarts(self):
        self.xui_fixture()
        with patch.object(m, 'ask', side_effect=['new-user', 'ДА']), patch.object(m.getpass, 'getpass', return_value='new-password-123'), patch.object(m, 'run', side_effect=['container-id', '', 'Failed to update username and password', '']) as run:
            with self.assertRaises(ValueError): m.xui_change(self.args, self.root, 'password')
        self.assertEqual(json.loads((self.root / '3xui/credentials.json').read_text())['password'], 'old-secret')
        self.assertEqual(run.call_args_list[-1].args[0][-2:], ['start', 'local-3xui'])

    def test_token_cancel_never_calls_docker(self):
        self.xui_fixture()
        with patch.object(m, 'ask', return_value='НЕТ'), patch.object(m, 'run') as run:
            m.xui_change(self.args, self.root, 'token')
        run.assert_not_called()

    def test_token_generation_preserves_stopped_service(self):
        self.xui_fixture()
        with patch.object(m, 'ask', return_value='ДА'), patch.object(m, 'show_credentials'), patch.object(m, 'run', side_effect=['', 'apiToken: example-test-token\n']) as run:
            m.xui_change(self.args, self.root, 'token')
        self.assertEqual(run.call_count, 2)
        self.assertEqual(json.loads((self.root / '3xui/credentials.json').read_text())['api_token'], 'example-test-token')

    def test_initial_token_created_once_and_not_rotated_by_rerun(self):
        self.xui_fixture()
        item = state()['providers']['3xui']; item['supports_api_token'] = True
        with patch.object(m, 'run', side_effect=['', 'hasDefaultCredential: false\nport: 2053\nwebBasePath: /base/\n', 'apiToken: first-token\n']) as run:
            m.ensure_3xui_initialized(item, self.root)
            m.ensure_3xui_initialized(item, self.root)
        self.assertEqual(run.call_count, 3)
        self.assertEqual(json.loads((self.root / '3xui/credentials.json').read_text())['api_token'], 'first-token')

    def test_render_idempotent_and_recreated_after_nexus_files_replaced(self):
        self.save()
        (self.app / "docker-compose.yml").write_text("services:\n  aggregator:\n    image: test\n  caddy:\n    image: caddy:2\n")
        (self.app / "Caddyfile").write_text("nexus.example.com {\n reverse_proxy aggregator:3000\n}\n")
        m.render(self.args, self.root); m.render(self.args, self.root)
        caddy = (self.app / "Caddyfile").read_text()
        self.assertEqual(caddy.count("import /etc/caddy/nexus-local/*.caddy"), 1)
        old = (self.app / "docker-compose.override.yml").read_bytes()
        (self.app / "docker-compose.override.yml").unlink()
        m.render(self.args, self.root)
        self.assertEqual(old, (self.app / "docker-compose.override.yml").read_bytes())
        self.assertEqual(json.loads(old)["services"]["caddy"]["container_name"], "nexus-test-caddy")

    def test_custom_override_is_not_overwritten(self):
        self.save(); override = self.app / "docker-compose.override.yml"
        override.write_text("user configuration")
        with self.assertRaises(ValueError): m.render(self.args, self.root)
        self.assertEqual(override.read_text(), "user configuration")

    def test_none_selection_does_not_create_files_or_call_docker(self):
        with patch.object(m, "ask", return_value="0"), patch.object(m, "run") as run:
            m.wizard(self.args, self.root)
        self.assertFalse(self.root.exists()); run.assert_not_called()

    def test_rerun_does_not_replace_existing_version_or_credentials(self):
        self.save()
        before = (self.root / "state.json").read_bytes()
        with patch.object(m, "ask", return_value="3"), patch.object(m, "run") as run:
            m.wizard(self.args, self.root)
        self.assertEqual(before, (self.root / "state.json").read_bytes()); run.assert_not_called()

    def test_remna_recipe_uses_selected_tag_schema_and_random_secrets(self):
        upstream = "    image: postgres:18.4\n    image: valkey/valkey:9-alpine\n      - remnawave-db-data:/var/lib/postgresql\n"
        env = "APP_SECRET=change_me\nREDIS_SOCKET=/var/run/valkey/valkey.sock\nDATABASE_URL=postgres\nPOSTGRES_PASSWORD=postgres\nFRONT_END_DOMAIN=*\nSUB_PUBLIC_DOMAIN=example.com/api/sub\n"
        with patch.object(m, "fetch", side_effect=[upstream, env]) as fetch:
            recipe, configured = m.remna_recipe("3.4.3", "rw.example.com")
        self.assertIn("/3.4.3/", fetch.call_args_list[0].args[0])
        self.assertEqual(recipe["pg_target"], "/var/lib/postgresql")
        self.assertEqual(len(configured["WEBHOOK_SECRET_HEADER"]), 64)
        self.assertNotEqual(configured["POSTGRES_PASSWORD"], "postgres")
        self.assertIn(configured["POSTGRES_PASSWORD"], configured["DATABASE_URL"])
        self.assertEqual(configured["SUB_PUBLIC_DOMAIN"], "rw.example.com/api/sub")

    def test_remna_unknown_schema_fails_before_deployment(self):
        with patch.object(m, "fetch", side_effect=["services: {}", "NEW_SECRET=changed"]):
            with self.assertRaises(ValueError): m.remna_recipe("9.0.0", "rw.example.com")

    def test_xui_credentials_set_before_exposing_any_port_and_only_once(self):
        item = state()["providers"]["3xui"]
        m.private_write(self.root / "3xui/credentials.json", json.dumps({"username": "u", "password": "secret", "path": "/test-path/"}))
        with patch.object(m, "run", side_effect=["", "hasDefaultCredential: false\nport: 2053\nwebBasePath: /test-path/"]) as run:
            m.ensure_3xui_initialized(item, self.root)
            m.ensure_3xui_initialized(item, self.root)
        self.assertEqual(run.call_count, 2)
        command = run.call_args_list[0].args[0]
        self.assertIn("none", command); self.assertNotIn("-p", command)
        self.assertTrue((self.root / "3xui/.initialized").exists())

    def test_xui_unsafe_defaults_never_mark_initialized(self):
        m.private_write(self.root / "3xui/credentials.json", json.dumps({"username": "u", "password": "secret", "path": "/test-path/"}))
        with patch.object(m, "run", side_effect=["", "hasDefaultCredential: true\nport: 2053"]):
            with self.assertRaises(ValueError): m.ensure_3xui_initialized(state()["providers"]["3xui"], self.root)
        self.assertFalse((self.root / "3xui/.initialized").exists())

    def test_docker_pull_failure_never_initializes_or_starts(self):
        self.save()
        with patch.object(m, "run", side_effect=["--wait", "", RuntimeError("pull failed")]) as run, patch.object(m, "ensure_3xui_initialized") as init:
            with self.assertRaises(RuntimeError): m.apply_providers(state(), self.root)
        init.assert_not_called(); self.assertEqual(run.call_count, 3)
        self.assertTrue((self.root / "state.json").exists())

    def test_installer_integration_is_opt_in_and_ordinary_update_never_pulls_providers(self):
        source = (SCRIPT.parent.parent / "install.sh").read_text(encoding="utf-8")
        fresh = source.split("fresh_install_flow() {", 1)[1].split("\n}", 1)[0]
        self.assertIn("local_panels_command wizard", fresh)
        self.assertIn("can_update_from_local_bundle", fresh)
        update = source.split("update_files_only() {", 1)[1].split("\n}", 1)[0]
        self.assertNotIn("local_panels_command wizard", update)
        self.assertNotIn("apply_providers", update)
        self.assertIn("local_panels_command render", source)
        self.assertIn('"local-panels"', source)
        shortcuts = source.split('install_shortcut_command() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('local_panels_command install-cli', shortcuts)
        result = source.split('print_result() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('local_panels_command credentials', result)


if __name__ == "__main__":
    unittest.main()
