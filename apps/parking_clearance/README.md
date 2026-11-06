# Parking & Clearance

Version 0.1.6 decodes the BMW steering-angle offset correctly and replaces the old guide rays with paired tyre-path tracks.

A full-screen, read-only parking dashboard for iDrive 7.

- Twelve front, rear and side PMA/PDC distance channels are read in a slow
  round-robin so no actuator or calibration request is sent.
- The steering-wheel angle draws a simple projected path. It is guidance only,
  not a calibrated camera overlay.
- VDP sensor-relative corner values show stance and body lean. They are not
  ground-clearance or rim-to-fender measurements.
- PMA parking-space length/depth is shown when the factory space scan reports it.

The app only sends UDS `0x22` reads to PMA (`0x2C`) and VDP (`0x76`). It has no
write, routine-control, coding, fault-clear or actuator path.
