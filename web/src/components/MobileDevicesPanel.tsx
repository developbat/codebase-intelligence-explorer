import { useEffect, useState } from "react";
import { Camera, Loader2, Play, RefreshCw, Smartphone } from "lucide-react";
import type { MobileDevice } from "../../../shared/mobileDevices";
import type { MobileDeviceReport } from "../../../shared/mobileDevices";
import { api } from "../api";
import { useI18n } from "../i18n";

export function MobileDevicesPanel({ projectId }: { projectId?: string }) {
  const { t } = useI18n();
  const [report, setReport] = useState<MobileDeviceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    try {
      setReport(await api.mobileDevices());
    } catch {
      setReport(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function boot(device: MobileDevice) {
    if (!projectId) return;
    setActionBusy(`boot:${device.id}`);
    setMessage(null);
    try {
      const result = await api.mobileBoot(projectId, device.platform, device.id);
      setMessage(result.message);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not boot the device."));
    } finally {
      setActionBusy(null);
    }
  }

  async function screenshot(device: MobileDevice) {
    if (!projectId) return;
    setActionBusy(`shot:${device.id}`);
    setMessage(null);
    try {
      const result = await api.mobileScreenshot(projectId, device.platform, device.id);
      setMessage(t("Screenshot saved: {path}", { path: result.path }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("Could not capture the screenshot."));
    } finally {
      setActionBusy(null);
    }
  }

  function deviceAction(device: MobileDevice) {
    if (!projectId) return null;
    const booted =
      device.platform === "ios" ? device.state === "booted" : device.state === "device";
    if (booted) {
      return (
        <button className="ghost-button" onClick={() => void screenshot(device)} disabled={actionBusy !== null}>
          {actionBusy === `shot:${device.id}` ? <Loader2 size={9} className="spin" /> : <Camera size={9} />}
          {t("Screenshot")}
        </button>
      );
    }
    if (device.platform === "ios" || device.id.startsWith("avd:")) {
      return (
        <button className="ghost-button" onClick={() => void boot(device)} disabled={actionBusy !== null}>
          {actionBusy === `boot:${device.id}` ? <Loader2 size={9} className="spin" /> : <Play size={9} />}
          {t("Boot")}
        </button>
      );
    }
    return null;
  }

  return (
    <section className="settings-section">
      <div className="mobile-devices-head">
        <div>
          <h3>
            <Smartphone size={13} /> {t("Mobile devices")}
          </h3>
          <p>{t("iOS Simulator and Android emulator/device availability on this machine.")}</p>
        </div>
        <button className="ghost-button" onClick={() => void load()} disabled={busy}>
          {busy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
          {t("Refresh")}
        </button>
      </div>
      {report ? (
        <div className="mobile-devices-grid">
          <div>
            <strong>iOS</strong>
            <small>{report.tools.xcrun ? t("{count} simulators", { count: report.ios.length }) : t("xcrun unavailable")}</small>
            {report.ios.slice(0, 8).map((device) => (
              <div key={device.id} className={`mobile-device-row ${device.state === "booted" ? "is-on" : ""}`}>
                <span>{device.name} · {device.state}</span>
                {deviceAction(device)}
              </div>
            ))}
          </div>
          <div>
            <strong>Android</strong>
            <small>{report.tools.adb || report.tools.emulator ? t("{count} devices", { count: report.android.length }) : t("adb unavailable")}</small>
            {report.android.slice(0, 8).map((device) => (
              <div key={device.id} className={`mobile-device-row ${device.state === "device" ? "is-on" : ""}`}>
                <span>{device.name} · {device.state}</span>
                {deviceAction(device)}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p>{t("Device status could not be read.")}</p>
      )}
      {message ? <div className="mobile-devices-message">{message}</div> : null}
    </section>
  );
}
