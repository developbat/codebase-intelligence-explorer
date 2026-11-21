import assert from "node:assert/strict";
import test from "node:test";
import { parseAdbDevices, parseAvds, parseIosDevices } from "./mobileDevices";

test("parses iOS simulators and Android devices", () => {
  const ios = parseIosDevices(
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
          { name: "iPhone 16 Pro", udid: "ABC", state: "Booted", isAvailable: true },
          { name: "Old iPhone", udid: "OLD", state: "Shutdown", isAvailable: false },
        ],
      },
    }),
  );
  assert.deepEqual(
    ios.map((device) => [device.name, device.state]),
    [["iPhone 16 Pro", "booted"]],
  );

  const android = parseAdbDevices(
    "List of devices attached\nemulator-5554 device product:sdk model:sdk_gphone64_arm64\nR58M offline\n",
  );
  assert.equal(android.length, 2);
  assert.equal(android[0].kind, "emulator");
  assert.equal(android[1].state, "offline");
  assert.equal(parseAvds("Pixel_9\nTablet_API_35\n").length, 2);
});
