import type { Messages } from '../../types'
import type { whatsNew as source } from '../en/whatsNew'

export const whatsNew: Messages<typeof source> = {
  title: 'Novedades',
  intro: 'Esto es lo nuevo desde la última vez que entraste.',
  allIntro: 'Todo lo que ha ido llegando al portal, de lo más reciente a lo más antiguo.',
  empty: 'Todavía no hay novedades.',
  gotIt: '¡Entendido!',
  showMore: { one: 'Ver {count} novedad más', other: 'Ver {count} novedades más' },
  goThere: 'Llévame allí',
  goThereLabel: 'Llévame allí: {title}',
  adminsOnly: 'Solo administradores',
  kinds: {
    new: 'Nuevo',
    improved: 'Mejorado',
    fixed: 'Arreglado',
  },
}
