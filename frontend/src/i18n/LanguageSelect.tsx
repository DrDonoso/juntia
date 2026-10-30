import { useId } from 'react'
import { Icon } from '../icons'
import { useI18n } from './react'
import { isLanguage, translate } from './translate'
import { LANGUAGES } from './types'

/** Language picker; every option is named in its own language ("English", "Español"). */
export function LanguageSelect({ className }: { className?: string }) {
  const { language, t, setLanguage } = useI18n()
  const id = useId()
  return <div className={className ? `language-select ${className}` : 'language-select'}>
    <label htmlFor={id}><Icon name="globe" size={16} />{t('common.language.label')}</label>
    <select id={id} value={language} onChange={event => {
      const next = event.target.value
      if (isLanguage(next)) setLanguage(next)
    }}>
      {LANGUAGES.map(code => <option key={code} value={code} lang={code}>{translate(code, 'common.language.name')}</option>)}
    </select>
  </div>
}
