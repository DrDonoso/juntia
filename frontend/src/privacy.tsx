import { createContext, useContext, type ReactNode } from 'react'
import { useI18n } from './i18n'

export const PrivacyContext = createContext(false)
export const usePrivateValues = () => useContext(PrivacyContext)

export function storedPrivacy(): boolean {
  try { return localStorage.getItem('juntia_hide_values') === '1' }
  catch { console.warn('Privacy preference is unavailable; values remain visible.'); return false }
}

export function PrivateValue({ children, hiddenLabel }: { children: ReactNode; hiddenLabel?: string }) {
  const { t } = useI18n()
  const hidden = usePrivateValues()
  return <><span className="sensitive-value" data-hidden={hidden || undefined} aria-hidden={hidden || undefined}>{children}</span>
    {hidden && <span className="sr-only">{hiddenLabel ?? t('common.hiddenAmount')}</span>}</>
}
