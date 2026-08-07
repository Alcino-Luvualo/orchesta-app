import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusWithoutScrolling(element: HTMLElement | null) {
  if (!element) return
  try {
    element.focus({ preventScroll: true })
  } catch {
    // Older WebViews do not support FocusOptions.
    element.focus()
  }
}

function getFocusableElements(modal: HTMLElement): HTMLElement[] {
  return Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => {
      if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true') return false
      // getClientRects also works for elements inside a fixed overlay, while
      // offsetParent is null for a few perfectly visible layout primitives.
      return element.getClientRects().length > 0 || element === document.activeElement
    })
}

interface ModalA11yOptions {
  open: boolean
  onClose: () => void
  initialFocusRef?: RefObject<HTMLElement | null>
}

/**
 * Small, dependency-free modal primitive shared by the renderer's dialogs.
 * It keeps keyboard focus inside the dialog, gives Escape one predictable
 * meaning, and returns focus to the control that opened it.
 */
export function useModalA11y({ open, onClose, initialFocusRef }: ModalA11yOptions) {
  const modalRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open || !modalRef.current) return

    const modal = modalRef.current
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let frame = 0

    const focusInitialControl = () => {
      const preferred = initialFocusRef?.current
      if (preferred && !preferred.hasAttribute('disabled')) {
        focusWithoutScrolling(preferred)
        return
      }
      const first = modal.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      focusWithoutScrolling(first || modal)
    }

    frame = window.requestAnimationFrame(focusInitialControl)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') return
      const focusable = getFocusableElements(modal)
      if (focusable.length === 0) {
        event.preventDefault()
        focusWithoutScrolling(modal)
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!modal.contains(document.activeElement)) {
        event.preventDefault()
        focusWithoutScrolling(event.shiftKey ? last : first)
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        focusWithoutScrolling(last)
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        focusWithoutScrolling(first)
      }
    }

    modal.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      modal.removeEventListener('keydown', handleKeyDown)
      if (previousActive && previousActive.isConnected) focusWithoutScrolling(previousActive)
    }
  }, [initialFocusRef, open])

  return modalRef
}
