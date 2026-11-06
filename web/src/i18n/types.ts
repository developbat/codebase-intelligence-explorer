export type Dictionary = Record<string, string>;
export type Locale = "en" | "tr" | "de" | "fr" | "es" | "pt" | "ru" | "zh" | "ja";

export interface LocaleInfo {
  id: Locale;
  label: string;
  nativeLabel: string;
  dateLocale: string;
  dictionary: Dictionary;
}
