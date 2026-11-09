# Parked BMW for Android

Android dashboard for the remote telemetry bridge. The app polls the authenticated relay every five seconds while open and prominently distinguishes a live awake-car update from a retained parked snapshot.

Version 0.3 displays cabin and exterior temperature, 12 V battery state, vehicle speed and four tyre pressures. When the car is online it also offers climate, front and rear defrost, front temperature/fan, and heat/vent stages for all four seats. The controls highlight the state reported by IHKA, including changes made physically inside the car. Commands expire after two minutes and report the car-side confirmation result. It does not collect or show vehicle location.

Build with Java 17 and Android SDK 35:

```sh
gradle :app:assembleDebug
```

The debug APK is also produced by the repository's `Build Parked BMW Android app` GitHub workflow.

In the Android app's **Setup** screen, enter the relay `endpoint`, `carId`, `readToken` and `commandToken` from `cloud/telemetry-worker/parked-bmw-connection.json`. Do not copy the car's write token to the phone.
