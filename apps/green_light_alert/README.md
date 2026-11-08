# Green Light Alert

Full-screen ID7 traffic-light monitor and drive-off alert.

The app uses the head unit's captured BMW SOME/IP catalog:

- `TrafficLightRecognitionFrontCameraLegacy.RecognitionTrafficLightCamera` supplies raw KAFAS light objects before BMW's regional UCC availability gate.
- `TrafficSignDisplayControl.displayForesight` remains as a fallback on cars where the native UCC layer is active.
- A red-to-green change for the same camera object while the car is below 3 km/h creates a full-screen alert and requests a short BMW gong.

The raw colour codes are visible on the Details page and configurable because BMW did not publish their enum labels in this interface version. The expected mapping is red `1`, green `3`.

Version 0.2.5 removes the misleading Germany-position simulation. The app now diagnoses BMW's real regional decision chain without changing location or coding: the map-derived ADAS `CCP.countryCode`, the driver-assistance country-display decision, the FAS UCC regional decision, and the availability of every traffic-light/UCC setting. It explicitly identifies the observed state where FAS accepts the region but native BMW settings service `0x3055` is absent, separating production/software eligibility from a country rejection.
