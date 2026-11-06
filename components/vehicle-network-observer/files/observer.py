#!/usr/bin/env python3
"""Passive MGU network inventory for the Vehicle Network OAP app.

Runs as root because AF_PACKET is needed to observe the internal automotive
VLANs. It never transmits a probe, changes an interface, or writes coding.
"""
import argparse
import ipaddress
import json
import os
import re
import signal
import socket
import struct
import subprocess
import tempfile
import time

STATE_DIR = "/var/opt/vehicle-network-observer"
STATE_FILE = os.path.join(STATE_DIR, "state.json")
ETH_ALL = 0x0003
MAX_AGE = 6 * 3600


def run_json(args):
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           text=True, timeout=4, check=False)
        return json.loads(p.stdout) if p.returncode == 0 and p.stdout.strip() else []
    except (OSError, ValueError, subprocess.SubprocessError):
        return []


def run_text(args):
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           text=True, timeout=4, check=False)
        return p.stdout if p.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def prefix_mask(prefix):
    return str(ipaddress.IPv4Network("0.0.0.0/%d" % int(prefix)).netmask)


def usable(ip):
    try:
        a = ipaddress.ip_address(ip)
        return not (a.is_unspecified or a.is_multicast or a.is_loopback)
    except ValueError:
        return False


def parse_interfaces(raw):
    out = []
    for item in raw or []:
        addresses = []
        for a in item.get("addr_info", []):
            address = a.get("local")
            if address:
                addresses.append({"family": a.get("family", ""), "address": address,
                                  "prefix": a.get("prefixlen"), "scope": a.get("scope", ""),
                                  "broadcast": a.get("broadcast", "")})
        out.append({"name": item.get("ifname", ""), "index": item.get("ifindex"),
                    "state": item.get("operstate", ""), "mac": item.get("address", ""),
                    "mtu": item.get("mtu"), "addresses": addresses})
    return out


def parse_interfaces_text(text):
    """Parse BusyBox `ip address show` (the MGU's ip has no JSON support)."""
    out = []
    current = None
    for line in text.splitlines():
        m = re.match(r"^(\d+):\s+([^:@]+)(?:@[^:]+)?:\s+<([^>]*)>.*?mtu\s+(\d+)", line)
        if m:
            current = {"index": int(m.group(1)), "name": m.group(2),
                       "state": "UP" if "UP" in m.group(3).split(",") else "DOWN",
                       "mtu": int(m.group(4)), "mac": "", "addresses": []}
            out.append(current)
            continue
        if not current:
            continue
        m = re.match(r"\s+link/\S+\s+([0-9a-fA-F:]{17})", line)
        if m:
            current["mac"] = m.group(1).lower()
            continue
        m = re.match(r"\s+(inet6?)\s+([^/\s]+)/([0-9]+)(.*)", line)
        if m:
            rest = m.group(4)
            b = re.search(r"\bbrd\s+(\S+)", rest)
            s = re.search(r"\bscope\s+(\S+)", rest)
            current["addresses"].append({"family": m.group(1), "address": m.group(2),
                                         "prefix": int(m.group(3)), "scope": s.group(1) if s else "",
                                         "broadcast": b.group(1) if b else ""})
    return out


def parse_routes(raw):
    return [{k: r.get(k) for k in ("dst", "gateway", "dev", "prefsrc", "src", "metric", "protocol")
             if r.get(k) is not None} for r in (raw or [])]


def parse_routes_text(text):
    out = []
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        r = {"dst": parts[0]}
        for key in ("via", "dev", "src", "metric"):
            if key in parts and parts.index(key) + 1 < len(parts):
                value = parts[parts.index(key) + 1]
                r[{"via": "gateway"}.get(key, key)] = int(value) if key == "metric" and value.isdigit() else value
        out.append(r)
    return out


def arp_neighbors():
    out = []
    try:
        with open("/proc/net/arp", "r", encoding="ascii") as f:
            for line in f.read().splitlines()[1:]:
                p = line.split()
                if len(p) >= 6:
                    out.append({"dst": p[0], "lladdr": p[3], "dev": p[5], "state": p[2]})
    except OSError:
        pass
    return out


def ssh_clients():
    """Remote IPv4 addresses of established/in-progress connections to local port 22."""
    out = set()
    try:
        with open("/proc/net/tcp", "r", encoding="ascii") as f:
            for line in f.read().splitlines()[1:]:
                p = line.split()
                if len(p) < 4:
                    continue
                local, remote, state = p[1], p[2], p[3]
                lip, lport = local.split(":")
                rip, rport = remote.split(":")
                if int(lport, 16) != 22 or state not in ("01", "02", "03") or rip == "00000000":
                    continue
                out.add(socket.inet_ntoa(struct.pack("<I", int(rip, 16))))
    except (OSError, ValueError):
        pass
    try:
        with open("/proc/net/tcp6", "r", encoding="ascii") as f:
            for line in f.read().splitlines()[1:]:
                p = line.split()
                if len(p) < 4:
                    continue
                local, remote, state = p[1], p[2], p[3]
                _lip, lport = local.split(":")
                rip, _rport = remote.split(":")
                if int(lport, 16) != 22 or state not in ("01", "02", "03") or int(rip, 16) == 0:
                    continue
                raw = bytes.fromhex(rip)
                raw = b"".join(raw[i:i + 4][::-1] for i in range(0, 16, 4))
                address = ipaddress.IPv6Address(raw)
                out.add(str(address.ipv4_mapped or address))
    except (OSError, ValueError):
        pass
    return out


def choose_candidate(network, used):
    # Keep the already-proven direct-ENET address when it belongs to this /16.
    preferred = ["169.254.187.226"] if network.prefixlen <= 16 else []
    for text in preferred:
        a = ipaddress.IPv4Address(text)
        if a in network and str(a) not in used:
            return str(a)
    offsets = [200, 226, 50, 100, 220, 240]
    for off in offsets:
        n = int(network.network_address) + off
        if n >= int(network.broadcast_address):
            continue
        text = str(ipaddress.IPv4Address(n))
        if text not in used:
            return text
    return ""


def access_plan(interfaces, devices, routes):
    local = []
    for iface in interfaces:
        for a in iface.get("addresses", []):
            if a.get("family") != "inet" or not usable(a.get("address", "")):
                continue
            try:
                network = ipaddress.IPv4Network("%s/%s" % (a["address"], a["prefix"]), strict=False)
            except (ValueError, TypeError):
                continue
            local.append((iface.get("name", ""), a["address"], int(a["prefix"]), network))
    laptop = [d for d in devices.values() if d.get("laptop") and d.get("family") == "inet"]
    laptop.sort(key=lambda d: d.get("lastSeen", 0), reverse=True)
    selected = None
    peer = None
    for d in laptop:
        try:
            p = ipaddress.IPv4Address(d["ip"])
        except ValueError:
            continue
        for row in local:
            if p in row[3]:
                selected, peer = row, d
                break
        if selected:
            break
    if not selected and local:
        def score(row):
            ip = ipaddress.IPv4Address(row[1])
            if ip.is_link_local:
                return 100
            if ip.is_private and not row[1].startswith("160.48."):
                return 80
            if row[1].startswith("160.48."):
                return 20
            return 40
        selected = max(local, key=score)
    if not selected:
        return {"reason": "No usable MGU IPv4 interface is up"}
    iface, car_ip, prefix, network = selected
    used = {d.get("ip") for d in devices.values()} | {x[1] for x in local}
    recommended = peer["ip"] if peer else choose_candidate(network, used)
    gateway = ""
    for r in routes:
        if r.get("dev") == iface and r.get("gateway"):
            gateway = r["gateway"]
            if r.get("dst") == "default":
                break
    return {"carIp": car_ip, "prefix": prefix, "mask": prefix_mask(prefix),
            "network": str(network), "broadcast": str(network.broadcast_address),
            "interface": iface, "laptopIp": peer["ip"] if peer else "",
            "recommendedIp": recommended, "gateway": gateway, "inRange": bool(peer),
            "reason": "SSH client observed on the MGU access network" if peer else
                      "Recommended unused address in the MGU access network"}


class Inventory:
    def __init__(self):
        self.started = time.time()
        self.devices = {}
        self.interfaces = []
        self.routes = []
        self.counters = {"frames": 0, "arp": 0, "ipv4": 0, "ipv6": 0,
                         "someipPackets": 0, "someipProviders": 0}
        self.local_ips = set()
        self.gateways = set()

    def refresh_system(self):
        self.interfaces = parse_interfaces(run_json(["ip", "-j", "address", "show"]))
        if not self.interfaces:
            self.interfaces = parse_interfaces_text(run_text(["ip", "address", "show"]))
        self.routes = parse_routes(run_json(["ip", "-j", "route", "show", "table", "all"]))
        if not self.routes:
            self.routes = parse_routes_text(run_text(["ip", "route", "show"]))
        self.local_ips = {a["address"] for i in self.interfaces for a in i.get("addresses", []) if a.get("address")}
        self.gateways = {r.get("gateway") for r in self.routes if r.get("gateway")}
        now = time.time()
        for iface in self.interfaces:
            for a in iface.get("addresses", []):
                if usable(a.get("address", "")):
                    self.observe(a["address"], iface.get("name", ""), iface.get("mac", ""), now, local=True)
        neighbors = run_json(["ip", "-j", "neigh", "show"]) or arp_neighbors()
        for n in neighbors:
            ip = n.get("dst", "")
            if usable(ip):
                self.observe(ip, n.get("dev", ""), n.get("lladdr", ""), now,
                             neighbor=True, gateway=ip in self.gateways)
        for ip in ssh_clients():
            self.observe(ip, now=now, laptop=True)

    def observe(self, ip, interface="", mac="", now=None, **flags):
        if not usable(ip):
            return
        now = now or time.time()
        family = "inet6" if ":" in ip else "inet"
        key = family + ":" + ip
        d = self.devices.get(key)
        if not d:
            d = {"ip": ip, "family": family, "firstSeen": now, "packets": 0,
                 "someipServices": 0, "services": []}
            self.devices[key] = d
        d["lastSeen"] = now
        d["packets"] = d.get("packets", 0) + (0 if flags.get("local") else 1)
        if interface and (flags.get("local") or not d.get("local")):
            d["interface"] = interface
        if mac and mac != "00:00:00:00:00:00":
            d["mac"] = mac.lower()
        for name in ("local", "neighbor", "gateway", "laptop"):
            if flags.get(name):
                d[name] = True
        self.set_role(d)
        return d

    @staticmethod
    def set_role(d):
        if d.get("laptop"):
            d["role"] = "Laptop / SSH client"
        elif d.get("gateway"):
            d["role"] = "Vehicle ENET gateway"
        elif d.get("local"):
            d["role"] = "MGU / head unit"
        elif d.get("someipServices"):
            d["role"] = "Vehicle ECU / SOME-IP provider"
        elif d.get("neighbor"):
            d["role"] = "Network peer / neighbor"
        else:
            d["role"] = "Observed network device"

    def someip(self, d, payload):
        if len(payload) < 24 or payload[0:4] != b"\xff\xff\x81\x00":
            return
        self.counters["someipPackets"] += 1
        end = min(len(payload), 24 + struct.unpack_from("!I", payload, 20)[0])
        services = set(d.get("services", []))
        for pos in range(24, end, 16):
            entry = payload[pos:pos + 16]
            if len(entry) == 16 and entry[0] == 1 and int.from_bytes(entry[9:12], "big"):
                services.add("%04X" % struct.unpack_from("!H", entry, 4)[0])
        if services:
            d["services"] = sorted(services)[:256]
            d["someipServices"] = len(services)
            self.set_role(d)

    def frame(self, frame, interface, now=None):
        now = now or time.time()
        if len(frame) < 14:
            return
        self.counters["frames"] += 1
        src_mac = ":".join("%02x" % b for b in frame[6:12])
        eth = struct.unpack_from("!H", frame, 12)[0]
        off = 14
        while eth in (0x8100, 0x88A8) and len(frame) >= off + 4:
            eth = struct.unpack_from("!H", frame, off + 2)[0]
            off += 4
        if eth == 0x0806 and len(frame) >= off + 28:
            self.counters["arp"] += 1
            ip = socket.inet_ntoa(frame[off + 14:off + 18])
            mac = ":".join("%02x" % b for b in frame[off + 8:off + 14])
            self.observe(ip, interface, mac, now, neighbor=True, gateway=ip in self.gateways)
            return
        if eth == 0x0800 and len(frame) >= off + 20:
            ihl = (frame[off] & 15) * 4
            if ihl < 20 or len(frame) < off + ihl:
                return
            ip = socket.inet_ntoa(frame[off + 12:off + 16])
            d = self.observe(ip, interface, src_mac, now, gateway=ip in self.gateways)
            self.counters["ipv4"] += 1
            proto = frame[off + 9]
            trans = off + ihl
            if proto in (6, 17) and len(frame) >= trans + 4:
                sport, dport = struct.unpack_from("!HH", frame, trans)
                if proto == 6 and dport == 22 and ip not in self.local_ips:
                    d["laptop"] = True
                    self.set_role(d)
                if proto == 17 and (sport == 30490 or dport == 30490) and len(frame) >= trans + 8:
                    self.someip(d, frame[trans + 8:])
            return
        if eth == 0x86DD and len(frame) >= off + 40:
            ip = socket.inet_ntop(socket.AF_INET6, frame[off + 8:off + 24])
            self.observe(ip, interface, src_mac, now)
            self.counters["ipv6"] += 1

    def snapshot(self):
        now = time.time()
        self.devices = {k: d for k, d in self.devices.items()
                        if d.get("local") or now - d.get("lastSeen", 0) < MAX_AGE}
        providers = sum(1 for d in self.devices.values() if d.get("someipServices"))
        self.counters["someipProviders"] = providers
        devices = list(self.devices.values())
        return {"schema": 1, "generatedAt": now, "observerStartedAt": self.started,
                "interfaces": self.interfaces, "routes": self.routes, "devices": devices,
                "access": access_plan(self.interfaces, self.devices, self.routes),
                "counters": self.counters}


def atomic_write(path, data):
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o755, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="state-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), sort_keys=True)
            f.write("\n")
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def serve(path, once=False):
    inv = Inventory()
    inv.refresh_system()
    raw = None
    if not once:
        try:
            raw = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_ALL))
            raw.setblocking(False)
        except OSError:
            raw = None
    stopping = False
    def stop(_signo, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    next_system = 0
    next_write = 0
    while not stopping:
        now = time.time()
        if now >= next_system:
            inv.refresh_system()
            next_system = now + 5
        if raw:
            for _ in range(500):
                try:
                    frame, address = raw.recvfrom(65535)
                except (BlockingIOError, InterruptedError):
                    break
                except OSError:
                    raw = None
                    break
                inv.frame(frame, address[0] if address else "", now)
        if now >= next_write:
            atomic_write(path, inv.snapshot())
            next_write = now + 1
            if once:
                break
        time.sleep(0.05)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", default=STATE_FILE)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    serve(args.state, args.once)


if __name__ == "__main__":
    main()
