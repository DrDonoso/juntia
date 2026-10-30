import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from './i18n'
import { Icon } from './icons'

export function ContactActions({ name, edit, history, remove, readOnly = false }: {
  name: string; edit: () => void; history: () => void; remove: () => void; readOnly?: boolean
}) {
  const { t } = useI18n()
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [open, setOpen] = useState<'first' | 'last' | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const options = [
    { id: 'edit', label: t('common.edit'), run: edit }, { id: 'history', label: t('common.history'), run: history },
    { id: 'delete', label: t('common.delete'), run: remove, danger: true },
  ].filter(option => !readOnly || option.id === 'history')
  const label = t('contacts.menu.label', { name })
  const positionMenu = useCallback(() => {
    if (!trigger.current || !menu.current) return
    const bounds = trigger.current.getBoundingClientRect()
    const height = menu.current.offsetHeight, width = menu.current.offsetWidth
    const next = {
      left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, bounds.bottom + height + 8 <= window.innerHeight ? bounds.bottom + 4 : bounds.top - height - 4),
    }
    setPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next)
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    positionMenu()
    buttons.current[open === 'last' ? options.length - 1 : 0]?.focus({ preventScroll: true })
  }, [open, positionMenu, options.length])
  useEffect(() => {
    if (!open) return
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(null)
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, positionMenu])
  function dismiss() { setOpen(null); trigger.current?.focus({ preventScroll: true }) }
  return <div className="contact-actions">
    <button ref={trigger} type="button" className="quiet icon-button" title={t('contacts.menu.title')} aria-label={label}
      aria-haspopup="menu" aria-expanded={!!open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(open ? null : 'first')} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(event.key === 'ArrowUp' ? 'last' : 'first')
        }
      }}><Icon name="more" /></button>
    {open && createPortal(<div id={id} ref={menu} role="menu" aria-label={label} className="contact-menu" style={position}
      onKeyDown={event => {
        const current = buttons.current.findIndex(button => button === document.activeElement)
        let next: number | undefined
        if (event.key === 'ArrowDown') next = (current + 1) % options.length
        if (event.key === 'ArrowUp') next = (current + options.length - 1) % options.length
        if (event.key === 'Home') next = 0
        if (event.key === 'End') next = options.length - 1
        if (next !== undefined) { event.preventDefault(); buttons.current[next]?.focus({ preventScroll: true }) }
        if (event.key === 'Escape') { event.preventDefault(); dismiss() }
        if (event.key === 'Tab') dismiss()
      }}>
      {options.map((option, index) => <button key={option.id} ref={node => { buttons.current[index] = node }} role="menuitem"
        type="button" className={`quiet${option.danger ? ' danger' : ''}`} onClick={() => { dismiss(); option.run() }}>{option.label}</button>)}
    </div>, document.body)}
  </div>
}
