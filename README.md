# Car Pulse

A home-screen web app for an ELM327 Bluetooth LE OBD scanner: live gauges, automatic trip recording and analytics,
engine health check and fault codes. Everything lives in this folder; all data stays on the phone.

## Using it on iPhone
1. Install the free **Bluefy – Web BLE Browser** from the App Store (Safari and Chrome cannot use Bluetooth).
2. Open this site's address in Bluefy and bookmark it.
3. Close any other scanner app, turn the ignition on, tap **Connect scanner** and pick the scanner (e.g. VEEPEAK).

Trips are saved automatically while connected. **Try a demo drive** works without a car.
Fuel figures are estimates from engine sensors; set tank size, engine size and fuel price under More.

## What it does
- **Drive:** live speed, rpm, fuel use, estimated crank power, load, ignition advance, range and trip cost.
- **Insights:** driving score, fuel use corrected against real fill-ups, fuel use by speed band, where the fuel energy went, the car's learned normal readings and anything that drifts from them.
- **Fuel:** log a fill-up; the price fills in from Statistics Canada's monthly city average (table 18-10-0001-01) and can be overridden.
- **Health:** check-engine status, stored / pending / permanent codes with freeze frame, emission monitors, trends.
- **Lab:** every supported sensor live, engine maps (time, ignition, fuel trim, BSFC), power curve and 0-100 / 80-120 timers, coast-down test for CdA and rolling resistance, Mode 06 monitor tests, ECU identifiers, CSV export, terminal.

Files: `index.html` (screens), `obd.js` (scanner link and OBD-II decoding), `core.js` (trip maths, learning, fuel prices), `ui.js` (rendering).
Power, BSFC and energy figures come from a road-load model (mass, CdA, rolling resistance in Lab > Vehicle and settings) and assume a flat road.
