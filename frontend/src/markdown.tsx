import { useId, useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { Link } from 'react-router'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { useI18n, type Translate } from './i18n'

/** Addresses of the images members upload into texts: the only images shown as pictures. */
const OWN_IMAGE = /^\/api\/(?:actions|events)\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FOOTNOTE_LABEL = 'footnote-label'

type HastNode = { type: string; children?: HastNode[]; properties?: Record<string, unknown> }

/** The footnotes' label keeps a fixed id: give it the text's prefix, like the other footnote ids. */
function footnoteLabel(prefix: string) {
  const visit = (node: HastNode) => {
    for (const child of node.children ?? []) {
      const properties = child.properties
      if (properties?.id === FOOTNOTE_LABEL) properties.id = prefix + FOOTNOTE_LABEL
      if (Array.isArray(properties?.ariaDescribedBy)) {
        properties.ariaDescribedBy = properties.ariaDescribedBy.map(id => id === FOOTNOTE_LABEL ? prefix + FOOTNOTE_LABEL : id)
      }
      visit(child)
    }
  }
  return (tree: HastNode) => visit(tree)
}

export function isOwnImage(src: unknown): src is string {
  return typeof src === 'string' && OWN_IMAGE.test(src)
}

function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  // A purged or missing image keeps its place and description, like a broken link would.
  if (failed) return <span className="markdown-image-missing">{t('common.markdown.imageUnavailable', { name: alt })}</span>
  return <a className="markdown-image" href={src} target="_blank" rel="noopener noreferrer" title={t('common.markdown.openImage')}>
    <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  </a>
}

function MarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) {
  // Empty after the URL check (javascript: and other unsafe schemes): plain text.
  if (!href) return <span>{children}</span>
  if (href.startsWith('#')) return <a href={href} {...props}>{children}</a>
  // Paths of the app (not `//host` or `/\host`, which browsers read as other sites) stay in the app.
  if (/^\/(?![/\\])/.test(href) && !href.startsWith('/api/')) return <Link to={href} {...props}>{children}</Link>
  return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
}

function markdownComponents(t: Translate): Components {
  return {
    // Headings in a text stay below the headings of the page that shows it.
    h1: 'h3', h2: 'h4', h3: 'h5', h4: 'h6', h5: 'h6', h6: 'h6',
    a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
    img: ({ src, alt }) => {
      const description = alt?.trim() || t('common.markdown.image')
      if (isOwnImage(src)) return <MarkdownImage key={src} src={src} alt={description} />
      // Other images are never loaded: their servers would learn who reads the text.
      return typeof src === 'string' && /^https?:\/\//i.test(src)
        ? <a href={src} target="_blank" rel="noopener noreferrer">{description}</a>
        : <span>{description}</span>
    },
    table: ({ children }) => <div className="markdown-table" tabIndex={0} role="region" aria-label={t('common.markdown.table')}>
      <table>{children}</table>
    </div>,
    input: ({ checked }) => <input type="checkbox" disabled checked={!!checked}
      aria-label={checked ? t('common.markdown.taskDone') : t('common.markdown.taskPending')} />,
  }
}

/**
 * A text written in GitHub-flavored Markdown, rendered as React elements: raw HTML is shown as
 * text, unsafe link schemes are dropped and single line breaks are kept, as in plain text.
 */
export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const { t } = useI18n()
  // Unique per text, so several texts on one page never share footnote ids.
  const prefix = `${useId().replace(/[^a-zA-Z0-9-]/g, '')}-`
  const components = useMemo(() => markdownComponents(t), [t])
  return <div className={className ? `markdown ${className}` : 'markdown'}>
    <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[[footnoteLabel, prefix]]} components={components}
      remarkRehypeOptions={{
        clobberPrefix: prefix,
        footnoteLabel: t('common.markdown.footnotes'),
        footnoteBackLabel: (index: number) => t('common.markdown.backToReference', { number: index + 1 }),
      }}>{text}</Markdown>
  </div>
}
