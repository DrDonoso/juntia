import type { Messages } from '../../types'
import type { labels as source } from '../en/labels'

export const labels: Messages<typeof source> = {
  eyebrow: 'ADMINISTRACIÓN',
  title: 'Etiquetas de la comunidad',
  description: 'Gestiona el nombre y el color de las etiquetas existentes. Los catálogos de actuaciones, contactos y gastos son independientes.',
  creation: 'Las nuevas etiquetas se crean al guardar una actuación o un contacto. Aquí no se eliminan etiquetas ni se modifica su historial.',
  edit: 'Editar {name}',
  catalogs: {
    actions: {
      title: 'Etiquetas de actuaciones',
      search: 'Buscar etiqueta de actuaciones',
      loading: 'Cargando etiquetas…',
      count: { one: '{count} etiqueta', other: '{count} etiquetas' },
      empty: {
        search: 'No hay etiquetas que coincidan con la búsqueda.',
        page: 'No hay etiquetas en esta página.',
        none: 'Todavía no hay etiquetas en este catálogo.',
      },
      saved: 'Etiqueta «{name}» guardada.',
      editTitle: 'Editar etiqueta: {name}',
      scope: 'El nombre y el color cambiarán en todas las actuaciones que usan esta etiqueta. Las asociaciones se conservan.',
      previewName: 'Etiqueta',
      preview: 'Vista previa de etiqueta',
      stale: 'Tu borrador se conserva. Consulta la etiqueta guardada antes de volver a guardar.',
      current: 'Versión actual de la etiqueta',
      save: 'Guardar etiqueta',
    },
    contacts: {
      title: 'Etiquetas de contactos',
      search: 'Buscar etiqueta de contactos',
      loading: 'Cargando etiquetas…',
      count: { one: '{count} etiqueta', other: '{count} etiquetas' },
      empty: {
        search: 'No hay etiquetas que coincidan con la búsqueda.',
        page: 'No hay etiquetas en esta página.',
        none: 'Todavía no hay etiquetas en este catálogo.',
      },
      saved: 'Etiqueta «{name}» guardada.',
      editTitle: 'Editar etiqueta: {name}',
      scope: 'El nombre y el color cambiarán en todas las fichas de contacto que usan esta etiqueta. Las asociaciones se conservan.',
      previewName: 'Etiqueta',
      preview: 'Vista previa de etiqueta',
      stale: 'Tu borrador se conserva. Consulta la etiqueta guardada antes de volver a guardar.',
      current: 'Versión actual de la etiqueta',
      save: 'Guardar etiqueta',
    },
  },
  editor: {
    name: 'Nombre',
    color: 'Color',
    reloadCurrent: 'Consultar versión actual',
    currentTitle: 'Versión actual',
    currentHelp: 'Se actualizarán los campos que no habías editado. Revisa tus cambios antes de guardar.',
    rebase: 'Actualizar base y conservar mi borrador',
  },
}
