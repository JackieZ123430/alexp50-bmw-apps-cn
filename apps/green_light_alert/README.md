# Green Light Alert

Full-screen ID7 traffic-light monitor and drive-off alert.

The app uses the head unit's captured BMW SOME/IP catalog:

- `TrafficLightRecognitionFrontCameraLegacy.RecognitionTrafficLightCamera` supplies raw KAFAS light objects before BMW's regional UCC availability gate.
- `TrafficSignDisplayControl.displayForesight` remains as a fallback on cars where the native UCC layer is active.
- A red-to-green change for the same camera object while the car is below 3 km/h creates a full-screen alert and requests a short BMW gong.

The raw colour codes are visible on the Details page and configurable because BMW did not publish their enum labels in this interface version. The expected mapping is red `1`, green `3`.

Version 0.2.1 adds a latched Germany road-test diagnostic. Switch it on while stationary and it publishes a Berlin coordinate through BMW's writable `GPSPositionCAN` field until explicitly switched off. It watches BMW's own UCC regional decision and then restores the exact original coordinate. It does not recode an ECU.
