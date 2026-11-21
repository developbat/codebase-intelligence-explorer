import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Smartphone } from "lucide-react";
import type { MobileDeviceReport } from "../../../shared/mobileDevices";
import { api } from "../api";
import { useI18n } from "../i18n";

export function MobileDevicesPanel() {
  const { t } = useI18n();
  const [report, setReport] = useState<MobileDeviceReport | null>(null);
  const [busy, setBusy] = useState(false);

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
              <span key={device.id} className={device.state === "booted" ? "is-on" : ""}>
                {device.name} · {device.state}
              </span>
            ))}
          </div>
          <div>
            <strong>Android</strong>
            <small>{report.tools.adb || report.tools.emulator ? t("{count} devices", { count: report.android.length }) : t("adb unavailable")}</small>
            {report.android.slice(0, 8).map((device) => (
              <span key={device.id} className={device.state === "device" ? "is-on" : ""}>
                {device.name} · {device.state}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p>{t("Device status could not be read.")}</p>
      )}
    </section>
  );
}
