"""Unit/dry-run tests: never start Docker, bind external ports, or edit /opt."""
import copy
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

    def test_duplicate_panel_domains_and_nexus_ports_fail(self):
        s = state(); s["providers"]["3xui"]["host"] = self.args.panel_domain
        with self.assertRaises(ValueError): m.validate_names(s, self.args)
        s["providers"]["3xui"].update(mode="ip", host="192.0.2.1", port=3000)
        with self.assertRaises(ValueError): m.validate_names(s, self.args)

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


if __name__ == "__main__":
    unittest.main()
