# Vehicle Network

Full-screen ID7 network inventory. A root observer installed alongside the app watches MGU interfaces, ARP, IPv4/IPv6 and SOME/IP traffic and writes a read-only snapshot to `/var/opt/vehicle-network-observer/state.json`.

The app shows only devices actually observed while the car is awake. It identifies an SSH client as the likely laptop and calculates the matching IPv4 address, prefix and subnet mask for direct ENET access.
