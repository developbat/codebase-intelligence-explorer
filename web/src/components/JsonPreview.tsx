import { useMemo } from "react";
import { Braces, TriangleAlert } from "lucide-react";
import { useI18n } from "../i18n";

export function JsonPreview({ value }: { value: string }) {
  const { t } = useI18n();
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(value) };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : t("Invalid JSON."),
      };
    }
  }, [value, t]);

  if (!parsed.ok) {
    return (
      <div className="studio-json-preview">
        <div className="studio-preview-note is-error">
          <TriangleAlert size={12} /> {parsed.error}
        </div>
        <pre className="studio-json-source">{value}</pre>
      </div>
    );
  }
  const summary = Array.isArray(parsed.value)
    ? t("Array · {count} items", { count: parsed.value.length })
    : parsed.value && typeof parsed.value === "object"
      ? t("Object · {count} keys", { count: Object.keys(parsed.value as object).length })
      : t("JSON value");
  return (
    <div className="studio-json-preview">
      <div className="studio-preview-note">
        <Braces size={12} /> {summary}
      </div>
      <pre className="studio-json-source">{JSON.stringify(parsed.value, null, 2)}</pre>
    </div>
  );
}
