import type { Messages } from '../../types'
import type { notifications as source } from '../en/notifications'

export const notifications: Messages<typeof source> = {
  title: 'Notificaciones',
  bellUnread: { one: 'Notificaciones: {count} sin leer', other: 'Notificaciones: {count} sin leer' },
  markAllRead: 'Marcar todas como leídas',
  markRead: 'Marcar como leída: {title}',
  dismiss: 'Descartar: {title}',
  unread: 'Sin leer',
  empty: 'No hay notificaciones. Aquí te avisaremos cuando algo necesite tu atención.',
  settingsLink: 'Ajustes de notificaciones',
  enableHere: 'Activar en este dispositivo',
  kinds: {
    statement_missing: {
      title: 'Falta el extracto de {month}',
      body: 'Aún no se ha importado: impórtalo en Gastos > Importar.',
      label: 'Extracto bancario pendiente',
      description: 'Desde el día 1 de cada mes, mientras no se haya importado el extracto del mes anterior.',
    },
  },
  settings: {
    title: 'Notificaciones',
    intro: 'Aparecen bajo la campana de arriba, en todas las páginas, y en los dispositivos donde las actives, también como notificaciones del móvil o del ordenador, de 9:00 a 21:00.',
    device: 'Notificaciones en este dispositivo',
    deviceOn: 'Este dispositivo las recibe mientras mantengas la sesión iniciada en él.',
    deviceOff: 'Actívalas para recibirlas también en este dispositivo.',
    on: 'Activadas',
    off: 'Desactivadas',
    working: 'Guardando…',
    unavailable: {
      demo: 'La demo no puede enviar notificaciones a tus dispositivos.',
      insecure: 'Las notificaciones necesitan que el portal se abra con HTTPS.',
      unsupported: 'Este navegador no puede recibir notificaciones del portal.',
      install: 'En un iPhone o iPad, añade antes el portal a la pantalla de inicio (Compartir > Añadir a pantalla de inicio) y actívalas desde allí.',
      denied: 'Las notificaciones están bloqueadas para este sitio: permítelas en los ajustes del navegador y vuelve aquí.',
    },
    kinds: 'De qué quieres enterarte',
  },
}
