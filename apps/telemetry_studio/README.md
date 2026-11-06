# Telemetry Studio

Telemetry Studio is a full-screen, read-only dashboard for the BMW MGU/iDrive 7.
It uses the head unit's existing vehicle providers and diagnostic read services;
it does not write coding, calibrations, actuator requests, or fault memory.

Pages:

- **Engine:** RPM, speed, gear, boost, power and torque with peak markers.
- **Thermals:** coolant, engine oil, transmission and ambient temperatures with
  five-minute traces.
- **Powertrain:** intake temperature, fuel pressure, ignition timing, requested
  versus actual boost/load and misfire counters when the engine controller
  exposes them.
- **Chassis:** longitudinal/lateral acceleration, four tyre pressures and
  temperatures, targets, and xDrive torque distribution when available.

The defaults target this 740d xDrive: 5,000 rpm, 235 kW,
metric units, full-screen rendering and no automatic demo data. Unsupported
signals stay hidden until the car proves that they work. Values with invalid
markers or implausible ranges are discarded rather than displayed.

The package has its own `telemetry_studio` identifier. It installs beside
M Vitals and never upgrades or replaces it.
