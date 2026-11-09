#!/usr/bin/env python3
"""BMW hotspot userspace Internet proxy and guarded ENET gateway.

The O18 kernel has no NAT support, so Internet is provided by explicit HTTP and
SOCKS5 proxies running as an mgu-uplink-authorized uid. Coding mode temporarily
permits one selected hotspot client to use the TCP/6801 and UDP/6811 ENET relay.
It never bridges interfaces and never changes ECU coding.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import selectors
import signal
import socket
import subprocess
import tempfile
import time

DATA_DIR = "/var/opt/hotspot-studio-helper"
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
RUN_DIR = "/run/hotspot-studio"
SOCKET_FILE = os.path.join(RUN_DIR, "control.sock")
UPLINK_LEASE = "/run/mgu-uplink/lease.json"
UPLINK_STATUS = "/run/mgu-uplink/status.json"
NFT_TABLE = "hotspot_studio"
NFT_COMMENT = "hotspot-studio"
RULE_PREF = 11850
CODING_RULE_PREF = 11849
DEFAULT_ZGW = "192.168.68.113"
HTTP_PROXY_PORT = 3128
SOCKS_PROXY_PORT = 1088
ENET_PROXY_PORT = 6801


def command(args, stdin=None, timeout=4):
    try:
        p = subprocess.run(args, input=stdin, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, timeout=timeout,
                           check=False)
        return p.returncode, p.stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        return 127, str(exc)


def text(args):
    code, out = command(args)
    return out if code == 0 else ""


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return {} if default is None else default


def atomic_json(path, value, mode=0o644):
    os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="state-", suffix=".json", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, separators=(",", ":"), sort_keys=True)
            stream.write("\n")
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def ipv4_interfaces(output=None):
    raw = output if output is not None else text(["ip", "-o", "-4", "address", "show"])
    found = []
    for line in raw.splitlines():
        match = re.match(r"^\d+:\s+([^\s:@]+)(?:@\S+)?\s+inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)", line)
        if not match:
            continue
        name, address, prefix = match.groups()
        try:
            network = ipaddress.ip_network(address + "/" + prefix, strict=False)
        except ValueError:
            continue
        found.append({"name": name, "address": address, "prefix": int(prefix),
                      "network": str(network)})
    return found


def arp_neighbors(output=None):
    if output is None:
        try:
            with open("/proc/net/arp", "r", encoding="ascii") as stream:
                output = stream.read()
        except OSError:
            output = ""
    result = []
    for line in output.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 6:
            continue
        try:
            ipaddress.ip_address(fields[0])
        except ValueError:
            continue
        if fields[3] == "00:00:00:00:00:00":
            continue
        result.append({"ip": fields[0], "mac": fields[3].lower(), "interface": fields[5]})
    return result


def route_to(address, output=None):
    raw = output if output is not None else text(["ip", "route", "get", address])
    match = re.search(r"\bdev\s+(\S+)", raw)
    src = re.search(r"\bsrc\s+(\d+\.\d+\.\d+\.\d+)", raw)
    return {"interface": match.group(1) if match else "",
            "source": src.group(1) if src else "", "raw": raw}


def choose_hotspot(interfaces, uplink, vehicle, neighbors):
    by_interface = {}
    for peer in neighbors:
        by_interface[peer["interface"]] = by_interface.get(peer["interface"], 0) + 1
    candidates = []
    for item in interfaces:
        name = item["name"]
        if name in ("lo", uplink, vehicle) or name.startswith(("veth", "docker", "virbr")):
            continue
        network = ipaddress.ip_network(item["network"])
        address = ipaddress.ip_address(item["address"])
        if not address.is_private or address.is_link_local or str(network) == "192.168.68.0/22":
            continue
        score = 10 + by_interface.get(name, 0) * 12
        lower = name.lower()
        if lower == "wlan_bridge":
            score += 140
        elif "hotspot" in lower or lower.startswith(("ap", "uap")):
            score += 100
        if lower.startswith("wlan0"):
            score += 80
        elif lower.startswith("wlan"):
            score += 55
        if lower.startswith(("br", "bridge")):
            score += 45
        candidates.append((score, item))
    return max(candidates, key=lambda row: row[0])[1] if candidates else None


def safe_name(value):
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,32}", value or ""):
        raise ValueError("Unsafe interface name")
    return value


def nft_quote(value):
    return json.dumps(safe_name(value))


def own_ruleset(hotspot, uplink, network, vehicle, zgw, client=None, dns=None):
    hot, up = nft_quote(hotspot), nft_quote(uplink)
    vehicle_rule = ""
    coding_nat = ""
    if client and vehicle:
        veh = nft_quote(vehicle)
        vehicle_rule = (f'\t\tiifname {hot} oifname {veh} ip saddr {client} ip daddr {zgw} accept\n')
        coding_nat = f'\t\toifname {veh} ip saddr {client} ip daddr {zgw} masquerade\n'
    prerouting = []
    if dns:
        parsed_dns = ipaddress.ip_address(dns)
        if parsed_dns.version == 4:
            dns_address = str(parsed_dns)
            prerouting.extend([
                f'\t\tiifname {hot} udp dport 53 dnat to {dns_address}',
                f'\t\tiifname {hot} tcp dport 53 dnat to {dns_address}',
            ])
    if client:
        # ISTA/E-Sys can use the ZGW address directly. This additionally turns
        # the selected client's UDP 6811 discovery broadcast into a ZGW unicast.
        prerouting.append(f'\t\tiifname {hot} ip saddr {client} udp dport 6811 dnat to {zgw}')
    prerouting_chain = ""
    if prerouting:
        prerouting_chain = ('\tchain prerouting {\n'
                            '\t\ttype nat hook prerouting priority -100; policy accept;\n' +
                            '\n'.join(prerouting) + '\n\t}\n')
    return f'''add table ip {NFT_TABLE}
table ip {NFT_TABLE} {{
{prerouting_chain}\
\tchain guard {{
\t\ttype filter hook forward priority -20; policy accept;
{vehicle_rule}\t\tiifname {hot} oifname != {up} drop
\t}}
\tchain postrouting {{
\t\ttype nat hook postrouting priority 100; policy accept;
\t\toifname {up} ip saddr {network} masquerade
{coding_nat}\t}}
}}
'''


def chain_exists(family, table, chain):
    return command(["nft", "list", "chain", family, table, chain])[0] == 0


def delete_commented_rules(family, table, chain):
    code, listing = command(["nft", "-a", "list", "chain", family, table, chain])
    if code != 0:
        return
    handles = []
    for line in listing.splitlines():
        if 'comment "' + NFT_COMMENT + '"' not in line:
            continue
        match = re.search(r"# handle\s+(\d+)", line)
        if match:
            handles.append(match.group(1))
    for handle in handles:
        command(["nft", "delete", "rule", family, table, chain, "handle", handle])


def insert_accept(family, table, chain, tokens):
    if not chain_exists(family, table, chain):
        return
    args = ["nft", "insert", "rule", family, table, chain] + list(tokens) + ["accept", "comment", json.dumps(NFT_COMMENT)]
    code, out = command(args)
    if code != 0:
        raise RuntimeError(out or "Could not add firewall exception")


def delete_policy_rules():
    for line in text(["ip", "rule", "show"]).splitlines():
        match = re.match(r"^(%d|%d):" % (RULE_PREF, CODING_RULE_PREF), line.strip())
        if match:
            command(["ip", "rule", "del", "pref", match.group(1)])


def cleanup_network():
    command(["nft", "delete", "table", "ip", NFT_TABLE])
    for family, table in (("inet", "mgu_uplink"), ("ip", "filter")):
        delete_commented_rules(family, table, "forward")
    delete_policy_rules()


def retire_legacy_helper():
    """Stop the earlier standalone sharing script if it was installed."""
    unit = "/etc/systemd/system/mgu-hotspot-share.service"
    if os.path.exists(unit):
        command(["systemctl", "disable", "--now", "mgu-hotspot-share.service"], timeout=12)
    command(["nft", "delete", "table", "ip", "mgu_hotspot_share"])
    for family, table in (("inet", "mgu_uplink"), ("ip", "filter")):
        code, listing = command(["nft", "-a", "list", "chain", family, table, "forward"])
        if code != 0:
            continue
        for line in listing.splitlines():
            if 'comment "mgu-hotspot-share' not in line:
                continue
            match = re.search(r"# handle\s+(\d+)", line)
            if match:
                command(["nft", "delete", "rule", family, table, "forward", "handle", match.group(1)])
    for line in text(["ip", "rule", "show"]).splitlines():
        if line.strip().startswith("1090:") and "lookup 110" in line:
            command(["ip", "rule", "del", "pref", "1090"])


class Gateway:
    def __init__(self):
        retire_legacy_helper()
        settings = read_json(SETTINGS_FILE, {})
        self.internet_enabled = bool(settings.get("internetEnabled", False))
        self.zgw = str(settings.get("zgwAddress", DEFAULT_ZGW))
        try:
            ipaddress.ip_address(self.zgw)
        except ValueError:
            self.zgw = DEFAULT_ZGW
        self.coding = None
        self.error = ""
        self.last_reconcile = 0
        self.snapshot = {}
        cleanup_network()
        # Older Hotspot Studio releases enabled kernel forwarding before their
        # unsupported NAT rules failed.  The userspace gateway needs neither.
        self.set_forward("0")

    @staticmethod
    def read_forward():
        try:
            with open("/proc/sys/net/ipv4/ip_forward", "r", encoding="ascii") as stream:
                return stream.read().strip()
        except OSError:
            return "0"

    @staticmethod
    def set_forward(value):
        try:
            with open("/proc/sys/net/ipv4/ip_forward", "w", encoding="ascii") as stream:
                stream.write(str(value))
        except OSError as exc:
            raise RuntimeError("Could not enable IPv4 forwarding: " + str(exc))

    def save_settings(self):
        atomic_json(SETTINGS_FILE, {"internetEnabled": self.internet_enabled,
                                    "zgwAddress": self.zgw}, 0o644)

    def discover(self):
        lease = read_json(UPLINK_LEASE, {})
        status = read_json(UPLINK_STATUS, {})
        uplink = str(lease.get("interface") or "")
        vehicle_route = route_to(self.zgw)
        vehicle = vehicle_route["interface"]
        interfaces = ipv4_interfaces()
        neighbors = arp_neighbors()
        hotspot = choose_hotspot(interfaces, uplink, vehicle, neighbors)
        clients = []
        if hotspot:
            clients = [peer for peer in neighbors if peer["interface"] == hotspot["name"]]
            clients.sort(key=lambda peer: tuple(int(x) for x in peer["ip"].split(".")))
        return {"lease": lease, "uplinkStatus": status, "uplink": uplink,
                "vehicle": vehicle, "vehicleSource": vehicle_route["source"],
                "hotspot": hotspot, "clients": clients, "interfaces": interfaces}

    def inject_accepts(self, d, client):
        hotspot, uplink, vehicle = d["hotspot"]["name"], d["uplink"], d["vehicle"]
        hot, up = json.dumps(safe_name(hotspot)), json.dumps(safe_name(uplink))
        veh = json.dumps(safe_name(vehicle)) if vehicle else ""
        chains = (("inet", "mgu_uplink"), ("ip", "filter"))
        for family, table in chains:
            delete_commented_rules(family, table, "forward")
            insert_accept(family, table, "forward", ["iifname", hot, "oifname", up])
            insert_accept(family, table, "forward", ["iifname", up, "oifname", hot,
                                                       "ct", "state", "established,related"])
            if client and vehicle:
                insert_accept(family, table, "forward", ["iifname", hot, "oifname", veh,
                    "ip", "saddr", client, "ip", "daddr", self.zgw])
                insert_accept(family, table, "forward", ["iifname", veh, "oifname", hot,
                    "ip", "saddr", self.zgw, "ip", "daddr", client, "ct", "state", "established,related"])

    def apply(self, d):
        cleanup_network()
        self.set_forward("0")
        if not self.internet_enabled:
            return
        if not d["uplink"] or not d["lease"].get("ip"):
            raise RuntimeError("mgu-uplink is not online")
        if not d["hotspot"]:
            raise RuntimeError("BMW hotspot interface not found; turn the built-in hotspot on")
        code, out = command(["systemctl", "is-active", "--quiet", "hotspot-studio-proxy.service"])
        if code != 0:
            raise RuntimeError("Hotspot userspace proxy is not running" + ((": " + out) if out else ""))

    def reconcile(self):
        now = time.time()
        if self.coding and now >= self.coding["expiresAt"]:
            self.coding = None
        d = self.discover()
        try:
            self.apply(d)
            self.error = ""
        except Exception as exc:
            self.error = str(exc)
            cleanup_network()
        self.last_reconcile = now
        hotspot = d["hotspot"] or {}
        uplink_status = d["uplinkStatus"] or {}
        self.snapshot = {
            "schema": 1, "generatedAt": now,
            "mode": "coding" if self.coding else ("internet" if self.internet_enabled else "off"),
            "internetEnabled": self.internet_enabled,
            "error": self.error or None,
            "uplink": {"interface": d["uplink"], "address": d["lease"].get("ip", ""),
                       "state": uplink_status.get("state", "offline"),
                       "device": (uplink_status.get("device") or {}).get("name", ""),
                       "dns": d["lease"].get("dns") or []},
            "hotspot": {"interface": hotspot.get("name", ""), "address": hotspot.get("address", ""),
                        "network": hotspot.get("network", ""), "clients": d["clients"]},
            "vehicle": {"interface": d["vehicle"], "zgw": self.zgw,
                        "source": d["vehicleSource"], "reachable": bool(d["vehicle"])},
            "proxy": {"address": hotspot.get("address", ""),
                      "httpPort": HTTP_PROXY_PORT, "socksPort": SOCKS_PROXY_PORT,
                      "enetPort": ENET_PROXY_PORT,
                      "transport": "userspace"},
            "coding": self.coding,
            "rulesActive": bool(self.internet_enabled and not self.error),
        }
        atomic_json(STATE_FILE, self.snapshot)
        return self.snapshot

    def handle(self, message):
        action = message.get("action", "status")
        if action == "status":
            return {"ok": True, "state": self.reconcile()}
        if action == "internet":
            self.internet_enabled = bool(message.get("enabled"))
            if not self.internet_enabled:
                self.coding = None
            self.save_settings()
        elif action == "coding":
            if message.get("parked") is not True:
                raise ValueError("Coding Gateway requires fresh Park and zero-speed signals")
            d = self.discover()
            client = str(message.get("client") or "")
            if client not in [peer["ip"] for peer in d["clients"]]:
                raise ValueError("Select a connected BMW hotspot client")
            minutes = max(5, min(60, int(message.get("minutes") or 20)))
            self.internet_enabled = True
            self.coding = {"client": client, "startedAt": time.time(),
                           "expiresAt": time.time() + minutes * 60, "minutes": minutes}
            self.save_settings()
        elif action == "coding-off":
            self.coding = None
        elif action == "off":
            self.internet_enabled = False
            self.coding = None
            self.save_settings()
        else:
            raise ValueError("Unknown action")
        return {"ok": True, "state": self.reconcile()}

    def close(self):
        cleanup_network()
        try:
            self.set_forward("0")
        except Exception:
            pass


def serve():
    os.makedirs(RUN_DIR, mode=0o770, exist_ok=True)
    try:
        os.unlink(SOCKET_FILE)
    except OSError:
        pass
    gateway = Gateway()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.setblocking(False)
    server.bind(SOCKET_FILE)
    os.chmod(SOCKET_FILE, 0o660)
    server.listen(8)
    selector = selectors.DefaultSelector()
    selector.register(server, selectors.EVENT_READ)
    buffers = {}
    stopping = False

    def stop(_signo, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    next_tick = 0
    try:
        while not stopping:
            now = time.time()
            if now >= next_tick:
                gateway.reconcile()
                next_tick = now + 2
            for key, _mask in selector.select(timeout=0.25):
                if key.fileobj is server:
                    conn, _ = server.accept()
                    conn.setblocking(False)
                    buffers[conn] = b""
                    selector.register(conn, selectors.EVENT_READ)
                    continue
                conn = key.fileobj
                try:
                    data = conn.recv(65536)
                    if not data:
                        raise ConnectionError()
                    buffers[conn] += data
                    if b"\n" not in buffers[conn]:
                        continue
                    line, _rest = buffers[conn].split(b"\n", 1)
                    try:
                        reply = gateway.handle(json.loads(line.decode("utf-8")))
                    except Exception as exc:
                        reply = {"ok": False, "error": str(exc), "state": gateway.snapshot}
                    conn.sendall((json.dumps(reply, separators=(",", ":")) + "\n").encode("utf-8"))
                except (OSError, ConnectionError):
                    pass
                finally:
                    try:
                        selector.unregister(conn)
                    except Exception:
                        pass
                    buffers.pop(conn, None)
                    conn.close()
    finally:
        gateway.close()
        server.close()
        try:
            os.unlink(SOCKET_FILE)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--discover", action="store_true")
    args = parser.parse_args()
    if args.cleanup:
        cleanup_network()
    elif args.discover:
        gateway = Gateway()
        print(json.dumps(gateway.reconcile(), indent=2))
        gateway.close()
    else:
        serve()


if __name__ == "__main__":
    main()
