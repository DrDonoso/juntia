import type { Messages } from '../../types'
import type { search as source } from '../en/search'

export const search: Messages<typeof source> = {
  label: 'Buscar en el portal',
  placeholder: 'Busca actuaciones, eventos, documentos, personas…',
  open: 'Buscar',
  close: 'Cerrar la búsqueda',
  results: 'Resultados de la búsqueda',
  loading: 'Buscando…',
  count: { zero: 'Sin resultados', one: '{count} resultado', other: '{count} resultados' },
  empty: 'Nada coincide con «{query}».',
  more: 'Solo se muestran los mejores resultados. Añade palabras para afinar la búsqueda.',
  kinds: {
    action: 'Actuación',
    event: 'Evento',
    folder: 'Carpeta',
    file: 'Documento',
    neighbor: 'Vecino',
    contact: 'Contacto',
    transaction: 'Movimiento',
  },
  sources: {
    comment: 'Comentario:',
    attachment: 'PDF:',
    labels: 'Etiquetas:',
    tags: 'Etiquetas:',
  },
  dwelling: 'Vivienda {label}',
}
