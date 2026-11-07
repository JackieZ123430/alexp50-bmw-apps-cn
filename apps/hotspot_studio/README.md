# Hotspot Studio

Full-screen control for sharing `mgu-uplink` through BMW's built-in hotspot.
Normal Internet mode cannot reach vehicle networks. Coding Gateway mode adds a
timed route from one selected hotspot client to the configured ZGW only and
requires fresh Park and zero-speed signals from the car.

The helper owns a dedicated nftables table and tagged exceptions. It does not
bridge interfaces, recode ECUs, or forward ENET broadcast discovery. Configure
ISTA or E-Sys with the ZGW address shown by the app.
