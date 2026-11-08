# Parked BMW for Android

Read-only Android dashboard for the remote telemetry bridge. The app polls the authenticated relay every 30 seconds while open and prominently distinguishes a live awake-car update from a retained parked snapshot.

Version 0.1 displays cabin temperature, exterior temperature, BMW's 12 V charge-condition percentage and four tyre pressures. It does not collect or show vehicle location.

Build with Java 17 and Android SDK 35:

```sh
gradle :app:assembleDebug
```

The debug APK is also produced by the repository's `Build Parked BMW Android app` GitHub workflow.

In the Android app's **Setup** screen, enter the relay `endpoint`, `carId` and `readToken` from `cloud/telemetry-worker/parked-bmw-connection.json`. Do not copy the car's write token to the phone.
