import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, LOCALES } from "./locales";
import type { Dictionary, Locale, LocaleInfo } from "./types";

type Vars = Record<string, string | number>;
type Translate = (source: string, vars?: Vars) => string;
type TranslatePlural = (count: number, one: string, other: string, vars?: Vars) => string;

interface I18nContextValue {
  locale: Locale;
  localeInfo: LocaleInfo;
  locales: LocaleInfo[];
  setLocale: (locale: Locale) => void;
  t: Translate;
  tn: TranslatePlural;
}

const STORAGE_KEY = "cie:locale";
const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    vars[key] === undefined ? match : String(vars[key]),
  );
}

function initialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && LOCALES.some((locale) => locale.id === stored)) return stored as Locale;
  return DEFAULT_LOCALE;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const localeInfo = useMemo(
    () => LOCALES.find((candidate) => candidate.id === locale) ?? LOCALES[0],
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const t = useCallback<Translate>(
    (source, vars) => {
      const dictionary: Dictionary = localeInfo.dictionary;
      return interpolate(dictionary[source] ?? source, vars);
    },
    [localeInfo],
  );

  const tn = useCallback<TranslatePlural>(
    (count, one, other, vars) => t(count === 1 ? one : other, { count, ...vars }),
    [t],
  );

  const value = useMemo(
    () => ({ locale, localeInfo, locales: LOCALES, setLocale, t, tn }),
    [locale, localeInfo, setLocale, t, tn],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}

export type { Locale, Translate };
