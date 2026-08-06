export {}

declare global {
  interface Window {
    orchestra?: {
      invoke: (type: string, payload?: any) => Promise<any>
      onEvent: (callback: (event: any) => void) => () => void
    }
  }
}
