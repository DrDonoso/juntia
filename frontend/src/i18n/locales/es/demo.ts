import type { Messages } from '../../types'
import type { demo as source } from '../en/demo'

export const demo: Messages<typeof source> = {
  banner: {
    label: 'Sobre esta demo',
    text: 'Demo · datos sintéticos · los cambios se pierden al recargar',
    source: 'Código fuente en GitHub',
    sourceLabel: 'Código fuente en GitHub (se abre en una pestaña nueva)',
  },
  welcome: {
    title: 'Te damos la bienvenida a la demo de Juntia',
    intro: 'Juntia es el portal privado de una comunidad de vecinos: las cuentas comunes a partir de los extractos del banco, las actuaciones y los eventos de la comunidad, los vecinos y los contactos.',
    data: 'Todo lo que ves son datos sintéticos que viven en tu navegador. Cambia lo que quieras: al recargar la página, la demo empieza de nuevo.',
    signedIn: 'Has entrado como {name}, residente de {community}. La administración también está a un clic.',
    neighbor: 'Explorar como vecino',
    admin: 'Abrir la administración',
    openingAdmin: 'Abriendo la administración…',
  },
  signIn: {
    resident: 'Demo: entra como <strong>{email}</strong> con la contraseña <strong>{password}</strong>. Todos los vecinos activos de la demo usan la misma contraseña.',
    admin: 'Demo: entra con el usuario <strong>{username}</strong> y la contraseña <strong>{password}</strong>.',
  },
  startError: {
    title: 'No se ha podido iniciar la demo',
    description: 'Esta demo funciona por completo en tu navegador y necesita service workers. Ábrela por HTTPS en una ventana normal (no privada) de un navegador actualizado.',
  },
}
