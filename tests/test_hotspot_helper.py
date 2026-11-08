import importlib.util
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
PATH = ROOT / "components" / "hotspot-studio-helper" / "files" / "hotspot_studio_helper.py"
SPEC = importlib.util.spec_from_file_location("hotspot_helper", PATH)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class HotspotHelperTests(unittest.TestCase):
    def test_parses_busybox_ip_addresses(self):
        rows = helper.ipv4_interfaces(
            "2: eth0    inet 192.168.68.114/22 brd 192.168.71.255 scope global eth0\n"
            "7: wlan0    inet 192.168.53.1/24 brd 192.168.53.255 scope global wlan0\n"
        )
        self.assertEqual(rows[1]["network"], "192.168.53.0/24")

    def test_prefers_bmw_wlan_with_a_client(self):
        interfaces = [
            {"name": "eth0", "address": "192.168.68.114", "prefix": 22, "network": "192.168.68.0/22"},
            {"name": "vethuplink", "address": "192.168.8.100", "prefix": 24, "network": "192.168.8.0/24"},
            {"name": "wlan0", "address": "192.168.53.1", "prefix": 24, "network": "192.168.53.0/24"},
        ]
        peers = [{"ip": "192.168.53.42", "mac": "00:11:22:33:44:55", "interface": "wlan0"}]
        picked = helper.choose_hotspot(interfaces, "vethuplink", "eth0", peers)
        self.assertEqual(picked["name"], "wlan0")

    def test_rules_keep_vehicle_closed_except_selected_client(self):
        rules = helper.own_ruleset("wlan0", "vethuplink", "192.168.53.0/24",
                                   "eth0", "192.168.68.113", "192.168.53.42", "192.168.8.1")
        self.assertIn("ip saddr 192.168.53.42 ip daddr 192.168.68.113 accept", rules)
        self.assertIn('iifname "wlan0" oifname != "vethuplink" drop', rules)
        self.assertIn("ip saddr 192.168.53.42 ip daddr 192.168.68.113 masquerade", rules)
        self.assertIn("udp dport 53 dnat to 192.168.8.1", rules)
        self.assertIn("ip saddr 192.168.53.42 udp dport 6811 dnat to 192.168.68.113", rules)

    def test_normal_rules_have_no_vehicle_exception(self):
        rules = helper.own_ruleset("wlan0", "vethuplink", "192.168.53.0/24",
                                   "eth0", "192.168.68.113")
        self.assertNotIn("192.168.68.113 accept", rules)
        self.assertIn('oifname != "vethuplink" drop', rules)

    def test_replaces_old_nft_table_before_loading_new_rules(self):
        gateway = helper.Gateway.__new__(helper.Gateway)
        gateway.internet_enabled = True
        gateway.coding = None
        gateway.zgw = "192.168.68.113"
        gateway.set_forward = lambda value: None
        gateway.inject_accepts = lambda discovered, client: None
        discovered = {
            "uplink": "vethuplink",
            "lease": {"ip": "192.168.8.100", "dns": ["192.168.8.1"]},
            "hotspot": {"name": "wlan0", "network": "192.168.53.0/24"},
            "vehicle": "eth0",
        }
        calls = []

        def record(args, stdin=None, timeout=4):
            calls.append((args, stdin))
            return 0, ""

        with mock.patch.object(helper, "command", side_effect=record):
            gateway.apply(discovered)

        self.assertEqual(calls[0][0], ["nft", "delete", "table", "ip", "hotspot_studio"])
        self.assertEqual(calls[1][0], ["nft", "-f", "-"])
        self.assertTrue(calls[1][1].startswith("add table ip hotspot_studio\ntable ip hotspot_studio {"))
        self.assertNotIn("delete table", calls[1][1])


if __name__ == "__main__":
    unittest.main()
