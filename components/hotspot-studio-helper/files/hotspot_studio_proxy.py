#!/usr/bin/env python3
"""Userspace Internet and ENET gateway for BMW's built-in hotspot.

The O18 MGU kernel has no nftables/iptables NAT support.  This service runs as
uid 65534, which mgu-uplink deliberately routes through the Huawei interface,
and exposes explicit HTTP and SOCKS5 proxies on the hotspot.  During a guarded
Coding Gateway session it also relays ENET discovery and TCP/6801 to the ZGW.
"""
from __future__ import annotations

import ipaddress
import json
import os
import select
import signal
import socket
import socketserver
import struct
import threading
import time
from urllib.parse import urlsplit


STATE_FILE = "/var/opt/hotspot-studio-helper/state.json"
HTTP_PORT = 3128
SOCKS_PORT = 1088
ENET_PORT = 6801
DISCOVERY_PORT = 6811
BUFFER = 65536


def state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return {}


def hotspot_address(snapshot=None):
    snapshot = snapshot or state()
    return str((snapshot.get("hotspot") or {}).get("address") or "172.16.222.97")


def peer_allowed(peer, coding=False):
    snapshot = state()
    hotspot = snapshot.get("hotspot") or {}
    try:
        if ipaddress.ip_address(peer) not in ipaddress.ip_network(hotspot.get("network") or "172.16.222.96/27"):
            return False
    except ValueError:
        return False
    if coding:
        session = snapshot.get("coding") or {}
        return (peer == session.get("client") and
                float(session.get("expiresAt") or 0) > time.time())
    return bool(snapshot.get("internetEnabled"))


def relay(left, right):
    """Copy a TCP stream in both directions without losing partial writes."""
    left.setblocking(True)
    right.setblocking(True)
    peers = {left: right, right: left}
    while True:
        try:
            readable, _, _ = select.select(tuple(peers), (), (), 90)
        except (OSError, ValueError):
            return
        if not readable:
            return
        for source in readable:
            try:
                data = source.recv(BUFFER)
                if not data:
                    return
                peers[source].sendall(data)
            except (OSError, InterruptedError):
                return


def _skip_dns_name(packet, offset):
    while offset < len(packet):
        length = packet[offset]
        if length & 0xC0 == 0xC0:
            return offset + 2
        offset += 1
        if length == 0:
            return offset
        offset += length
    raise OSError("truncated DNS name")


def resolve_ipv4(host, timeout=4):
    """Resolve through mgu-uplink's DNS because the stock resolver cannot use it."""
    try:
        socket.inet_aton(host)
        return host
    except OSError:
        pass
    labels = host.rstrip(".").encode("idna").split(b".")
    if not labels or any(not label or len(label) > 63 for label in labels):
        raise socket.gaierror("invalid host")
    txid = os.urandom(2)
    question = b"".join(bytes((len(label),)) + label for label in labels) + b"\0\0\1\0\1"
    request = txid + b"\1\0\0\1\0\0\0\0\0\0" + question
    servers = (state().get("uplink") or {}).get("dns") or ["192.168.8.1"]
    last_error = None
    for server in servers:
        dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            dns.settimeout(timeout)
            dns.sendto(request, (str(server), 53))
            packet, _ = dns.recvfrom(4096)
            if len(packet) < 12 or packet[:2] != txid or packet[3] & 0x0F:
                raise OSError("invalid DNS response")
            qdcount, ancount = struct.unpack("!HH", packet[4:8])
            offset = 12
            for _ in range(qdcount):
                offset = _skip_dns_name(packet, offset) + 4
            for _ in range(ancount):
                offset = _skip_dns_name(packet, offset)
                rtype, rclass, _, rdlength = struct.unpack("!HHIH", packet[offset:offset + 10])
                offset += 10
                if rtype == 1 and rclass == 1 and rdlength == 4:
                    return socket.inet_ntoa(packet[offset:offset + 4])
                offset += rdlength
        except (OSError, struct.error) as exc:
            last_error = exc
        finally:
            dns.close()
    raise socket.gaierror(str(last_error or "DNS lookup failed"))


def connect(host, port, timeout=12):
    return socket.create_connection((resolve_ipv4(host), int(port)), timeout=timeout)


class ReusableThreadingTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class HttpProxy(socketserver.StreamRequestHandler):
    def handle(self):
        if not peer_allowed(self.client_address[0]):
            return
        self.connection.settimeout(12)
        line = self.rfile.readline(16384)
        if not line:
            return
        try:
            method, target, version = line.decode("iso-8859-1").strip().split(" ", 2)
        except ValueError:
            return
        headers = []
        host_header = ""
        while True:
            row = self.rfile.readline(65536)
            if row in (b"", b"\r\n", b"\n"):
                break
            if row.lower().startswith((b"proxy-connection:", b"connection:")):
                continue
            headers.append(row)
            if row.lower().startswith(b"host:"):
                host_header = row.split(b":", 1)[1].strip().decode("iso-8859-1")
        try:
            if method.upper() == "CONNECT":
                host, port = split_host(target, 443)
                upstream = connect(host, port)
                self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                self.wfile.flush()
                relay(self.connection, upstream)
                upstream.close()
                return
            parsed = urlsplit(target)
            host, port = split_host(parsed.netloc or host_header, 80)
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            upstream = connect(host, port)
            upstream.sendall((method + " " + path + " " + version + "\r\n").encode("iso-8859-1"))
            for row in headers:
                upstream.sendall(row)
            upstream.sendall(b"Connection: close\r\n\r\n")
            relay(self.connection, upstream)
            upstream.close()
        except OSError:
            try:
                self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            except OSError:
                pass


def split_host(value, default_port):
    value = value.strip()
    if value.startswith("["):
        host, _, tail = value[1:].partition("]")
        return host, int(tail[1:]) if tail.startswith(":") else default_port
    if value.count(":") == 1:
        host, port = value.rsplit(":", 1)
        return host, int(port)
    return value, default_port


class SocksProxy(socketserver.BaseRequestHandler):
    def handle(self):
        sock = self.request
        if not peer_allowed(self.client_address[0]):
            return
        sock.settimeout(12)
        try:
            if recv_exact(sock, 1) != b"\x05":
                return
            methods = recv_exact(sock, recv_exact(sock, 1)[0])
            if 0 not in methods:
                sock.sendall(b"\x05\xff")
                return
            sock.sendall(b"\x05\x00")
            version, command, _reserved, atyp = recv_exact(sock, 4)
            if version != 5 or command != 1:
                return
            if atyp == 1:
                host = socket.inet_ntoa(recv_exact(sock, 4))
            elif atyp == 3:
                host = recv_exact(sock, recv_exact(sock, 1)[0]).decode("idna")
            elif atyp == 4:
                host = socket.inet_ntop(socket.AF_INET6, recv_exact(sock, 16))
            else:
                return
            port = struct.unpack("!H", recv_exact(sock, 2))[0]
            upstream = connect(host, port)
            sock.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
            relay(sock, upstream)
            upstream.close()
        except (OSError, IndexError, UnicodeError):
            try:
                sock.sendall(b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
            except OSError:
                pass


def recv_exact(sock, size):
    data = b""
    while len(data) < size:
        block = sock.recv(size - len(data))
        if not block:
            raise OSError("connection closed")
        data += block
    return data


class EnetProxy(socketserver.BaseRequestHandler):
    def handle(self):
        peer = self.client_address[0]
        if not peer_allowed(peer, coding=True):
            return
        snapshot = state()
        zgw = str((snapshot.get("vehicle") or {}).get("zgw") or "192.168.68.113")
        try:
            upstream = connect(zgw, ENET_PORT, timeout=5)
            relay(self.request, upstream)
            upstream.close()
        except OSError:
            pass


def discovery(stop):
    listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((hotspot_address(), DISCOVERY_PORT))
    listener.settimeout(1)
    while not stop.is_set():
        try:
            payload, client = listener.recvfrom(4096)
        except socket.timeout:
            continue
        except OSError:
            break
        if not peer_allowed(client[0], coding=True):
            continue
        snapshot = state()
        zgw = str((snapshot.get("vehicle") or {}).get("zgw") or "192.168.68.113")
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.settimeout(1.5)
            probe.sendto(payload, (zgw, DISCOVERY_PORT))
            response, _ = probe.recvfrom(4096)
            listener.sendto(response, client)
        except OSError:
            pass
        finally:
            probe.close()
    listener.close()


def serve():
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    address = hotspot_address()
    servers = [
        ReusableThreadingTCPServer((address, HTTP_PORT), HttpProxy),
        ReusableThreadingTCPServer((address, SOCKS_PORT), SocksProxy),
        ReusableThreadingTCPServer((address, ENET_PORT), EnetProxy),
    ]
    threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
    for thread in threads:
        thread.start()
    disc = threading.Thread(target=discovery, args=(stop,), daemon=True)
    disc.start()
    while not stop.wait(1):
        pass
    for server in servers:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    serve()
