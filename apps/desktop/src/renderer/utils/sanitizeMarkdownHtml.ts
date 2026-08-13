export function sanitizeMarkdownHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('script, style, iframe, object, embed, form, input, button').forEach((element) => element.remove())
  document.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name)
      if (attribute.name === 'href' || attribute.name === 'src') {
        const value = attribute.value.trim().toLowerCase()
        if (value.startsWith('javascript:') || value.startsWith('vbscript:') || value.startsWith('data:text/html')) element.removeAttribute(attribute.name)
      }
    })
  })
  return document.body.innerHTML
}
