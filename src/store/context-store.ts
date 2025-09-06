import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface ContextState {
  activeContextTitle: string | null
  setActiveContextTitle: (title: string | null) => void
}

export const useContextStore = create<ContextState>()(
  devtools(
    set => ({
      activeContextTitle: null,
      setActiveContextTitle: title => set({ activeContextTitle: title }),
    }),
    {
      name: 'context-store',
    }
  )
)