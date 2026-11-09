# Hotspot Studio

Full-screen control for using `mgu-uplink` through BMW's built-in hotspot. The
O18 MGU kernel does not include NAT, so the helper exposes an HTTP proxy on
port 3128 and SOCKS5 on port 1088. Both make their outbound connections as an
uplink-authorized uid and remain bound to the BMW hotspot address.

Coding Gateway mode adds a timed TCP/6801 ENET relay and UDP/6811 discovery
responder for one selected hotspot client. It requires fresh Park and
zero-speed signals. Configure ISTA/E-Sys with the BMW hotspot gateway address
shown by the app, not the vehicle-side ZGW address.

The helper does not enable IP forwarding, bridge interfaces, install NAT rules,
or recode ECUs.
