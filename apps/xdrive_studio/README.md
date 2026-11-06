# xDrive Studio

Read-only xDrive and chassis telemetry for iDrive 7.

The torque-split page uses a transparent overhead Citrin Black G12 render,
with live front/rear axle and wheel-speed overlays drawn around the real body.

- Direct front/rear distribution from BMW's `BasicDataSet` when the car publishes it.
- Transfer-case front-axle torque from LMV `22 DB32` as a fallback.
- Four-wheel speed balance, steering angle, yaw and lateral/longitudinal acceleration.
- A status page that shows exactly which source is live.

The transfer-case percentage is labelled as an estimate because it compares
front-axle torque with engine torque multiplied by the current ZF 8HP ratio.
The app sends only UDS service `22` and never changes drivetrain state.
